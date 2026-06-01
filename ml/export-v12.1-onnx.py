"""
Export ml/cursor-v12.1.pt to ml/cursor-v12.1.onnx for onnxruntime-node consumption.
Architecture must match train-cursor-v12.1.py exactly (identical to v12).
"""
from pathlib import Path
import torch
import torch.nn as nn
from torchvision.models import mobilenet_v3_small

ROOT = Path(__file__).resolve().parent
PT = ROOT / "cursor-v12.1.pt"
ONNX = ROOT / "cursor-v12.1.onnx"
INPUT_W, INPUT_H = 768, 480


class CursorFullFrameNet(nn.Module):
    def __init__(self):
        super().__init__()
        b = mobilenet_v3_small(weights=None)
        self.backbone = b.features
        self.up1 = nn.Sequential(nn.ConvTranspose2d(576, 128, 4, 2, 1), nn.ReLU(inplace=True))
        self.up2 = nn.Sequential(nn.ConvTranspose2d(128, 64, 4, 2, 1), nn.ReLU(inplace=True))
        self.up3 = nn.Sequential(nn.ConvTranspose2d(64, 32, 4, 2, 1), nn.ReLU(inplace=True))
        self.position_head = nn.Conv2d(32, 1, 1)
        self.presence_head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(576, 1))

    def forward(self, x):
        feats = self.backbone(x)
        p = self.up3(self.up2(self.up1(feats)))
        return self.position_head(p), self.presence_head(feats)


def main():
    model = CursorFullFrameNet()
    model.load_state_dict(torch.load(PT, map_location="cpu", weights_only=True))
    model.eval()
    dummy = torch.randn(1, 3, INPUT_H, INPUT_W)
    torch.onnx.export(
        model, dummy, str(ONNX),
        input_names=["frame"],
        output_names=["heatmap_logits", "presence_logit"],
        dynamic_axes={
            "frame": {0: "batch"},
            "heatmap_logits": {0: "batch"},
            "presence_logit": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    print(f"Exported {ONNX}")
    print(f"  size: {ONNX.stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
