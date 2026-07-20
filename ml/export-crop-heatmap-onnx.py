"""Export the dual-head crop detector .pt -> .onnx (outputs: heatmap_logits [B,1,24,24],
presence_logit [B]). Usage: export-crop-heatmap-onnx.py [in.pt] [out.onnx]"""
import sys
from pathlib import Path
import torch
import torch.nn as nn

ROOT = Path(__file__).resolve().parent
PT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "crop-heatmap.pt"
ONNX = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "crop-heatmap.onnx"
CROP = 96


class CropDetector(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = nn.Sequential(
            nn.Conv2d(3, 16, 3, padding=1), nn.ReLU(inplace=True),
            nn.Conv2d(16, 16, 3, padding=1), nn.ReLU(inplace=True), nn.MaxPool2d(2),
            nn.Conv2d(16, 64, 3, padding=1), nn.ReLU(inplace=True),
            nn.Conv2d(64, 64, 3, padding=1), nn.ReLU(inplace=True), nn.MaxPool2d(2),
        )
        self.heatmap_head = nn.Conv2d(64, 1, 1)
        self.presence_head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(64, 1))

    def forward(self, x):
        f = self.backbone(x)
        return self.heatmap_head(f), self.presence_head(f).view(-1)


def main():
    m = CropDetector()
    m.load_state_dict(torch.load(PT, map_location="cpu", weights_only=True))
    m.eval()
    dummy = torch.randn(1, 3, CROP, CROP)
    torch.onnx.export(
        m, dummy, str(ONNX), input_names=["crop"], output_names=["heatmap_logits", "presence_logit"],
        dynamic_axes={"crop": {0: "batch"}, "heatmap_logits": {0: "batch"}, "presence_logit": {0: "batch"}},
        opset_version=17, dynamo=False,
    )
    print(f"Exported {ONNX} ({ONNX.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
