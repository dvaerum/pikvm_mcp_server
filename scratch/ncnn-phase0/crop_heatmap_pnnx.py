# pnnx model stat
# model inputshape = [1,3,96,96]f32
# FLOPS = 264.279M
# memory OPS = 2.621M

import os
import numpy as np
import tempfile, zipfile
import torch
import torch.nn as nn
import torch.nn.functional as F
try:
    import torchvision
    import torchaudio
except:
    pass

class Model(nn.Module):
    def __init__(self):
        super(Model, self).__init__()

        self.conv2d_0 = nn.Conv2d(bias=True, dilation=(1,1), groups=1, in_channels=3, kernel_size=(3,3), out_channels=16, padding=(1,1), padding_mode='zeros', stride=(1,1))
        self.conv2d_1 = nn.Conv2d(bias=True, dilation=(1,1), groups=1, in_channels=16, kernel_size=(3,3), out_channels=16, padding=(1,1), padding_mode='zeros', stride=(1,1))
        self.conv2d_2 = nn.Conv2d(bias=True, dilation=(1,1), groups=1, in_channels=16, kernel_size=(3,3), out_channels=64, padding=(1,1), padding_mode='zeros', stride=(1,1))
        self.conv2d_3 = nn.Conv2d(bias=True, dilation=(1,1), groups=1, in_channels=64, kernel_size=(3,3), out_channels=64, padding=(1,1), padding_mode='zeros', stride=(1,1))
        self.conv2d_4 = nn.Conv2d(bias=True, dilation=(1,1), groups=1, in_channels=64, kernel_size=(1,1), out_channels=1, padding=(0,0), padding_mode='zeros', stride=(1,1))
        self.F_linear_0 = nn.Linear(bias=True, in_features=64, out_features=1)

        archive = zipfile.ZipFile('crop_heatmap.pnnx.bin', 'r')
        self.conv2d_0.bias = self.load_pnnx_bin_as_parameter(archive, 'conv2d_0.bias', (16), 'float32')
        self.conv2d_0.weight = self.load_pnnx_bin_as_parameter(archive, 'conv2d_0.weight', (16,3,3,3), 'float32')
        self.conv2d_1.bias = self.load_pnnx_bin_as_parameter(archive, 'conv2d_1.bias', (16), 'float32')
        self.conv2d_1.weight = self.load_pnnx_bin_as_parameter(archive, 'conv2d_1.weight', (16,16,3,3), 'float32')
        self.conv2d_2.bias = self.load_pnnx_bin_as_parameter(archive, 'conv2d_2.bias', (64), 'float32')
        self.conv2d_2.weight = self.load_pnnx_bin_as_parameter(archive, 'conv2d_2.weight', (64,16,3,3), 'float32')
        self.conv2d_3.bias = self.load_pnnx_bin_as_parameter(archive, 'conv2d_3.bias', (64), 'float32')
        self.conv2d_3.weight = self.load_pnnx_bin_as_parameter(archive, 'conv2d_3.weight', (64,64,3,3), 'float32')
        self.conv2d_4.bias = self.load_pnnx_bin_as_parameter(archive, 'conv2d_4.bias', (1), 'float32')
        self.conv2d_4.weight = self.load_pnnx_bin_as_parameter(archive, 'conv2d_4.weight', (1,64,1,1), 'float32')
        self.F_linear_0.bias = self.load_pnnx_bin_as_parameter(archive, 'F_linear_0.bias', (1), 'float32')
        self.F_linear_0.weight = self.load_pnnx_bin_as_parameter(archive, 'F_linear_0.weight', (1,64), 'float32')
        archive.close()

    def load_pnnx_bin_as_parameter(self, archive, key, shape, dtype, requires_grad=True):
        return nn.Parameter(self.load_pnnx_bin_as_tensor(archive, key, shape, dtype), requires_grad)

    def load_pnnx_bin_as_tensor(self, archive, key, shape, dtype):
        fd, tmppath = tempfile.mkstemp()
        with os.fdopen(fd, 'wb') as tmpf, archive.open(key) as keyfile:
            tmpf.write(keyfile.read())
        m = np.memmap(tmppath, dtype=dtype, mode='r', shape=shape).copy()
        os.remove(tmppath)
        return torch.from_numpy(m)

    def forward(self, v_0):
        v_1 = self.conv2d_0(v_0)
        v_2 = F.relu(v_1)
        v_3 = self.conv2d_1(v_2)
        v_4 = F.relu(v_3)
        v_5 = F.max_pool2d(v_4, ceil_mode=False, dilation=(1,1), kernel_size=(2,2), padding=(0,0), return_indices=False, stride=(2,2))
        v_6 = self.conv2d_2(v_5)
        v_7 = F.relu(v_6)
        v_8 = self.conv2d_3(v_7)
        v_9 = F.relu(v_8)
        v_10 = F.max_pool2d(v_9, ceil_mode=False, dilation=(1,1), kernel_size=(2,2), padding=(0,0), return_indices=False, stride=(2,2))
        v_11 = self.conv2d_4(v_10)
        v_12 = F.adaptive_avg_pool2d(v_10, output_size=(1,1))
        v_13 = torch.flatten(v_12, end_dim=-1, start_dim=1)
        v_14 = self.F_linear_0(v_13)
        v_15 = v_14.reshape(1)
        return v_11, v_15

def export_torchscript():
    net = Model()
    net.float()
    net.eval()

    torch.manual_seed(0)
    v_0 = torch.rand(1, 3, 96, 96, dtype=torch.float)

    mod = torch.jit.trace(net, v_0)
    mod.save("crop_heatmap_pnnx.py.pt")

def export_onnx():
    net = Model()
    net.float()
    net.eval()

    torch.manual_seed(0)
    v_0 = torch.rand(1, 3, 96, 96, dtype=torch.float)

    torch.onnx.export(net, v_0, "crop_heatmap_pnnx.py.onnx", export_params=True, operator_export_type=torch.onnx.OperatorExportTypes.ONNX_ATEN_FALLBACK, opset_version=13, input_names=['in0'], output_names=['out0', 'out1'])

def export_pnnx():
    net = Model()
    net.float()
    net.eval()

    torch.manual_seed(0)
    v_0 = torch.rand(1, 3, 96, 96, dtype=torch.float)

    import pnnx
    pnnx.export(net, "crop_heatmap_pnnx.py.pt", v_0)

def export_ncnn():
    export_pnnx()

@torch.no_grad()
def test_inference():
    net = Model()
    net.float()
    net.eval()

    torch.manual_seed(0)
    v_0 = torch.rand(1, 3, 96, 96, dtype=torch.float)

    return net(v_0)

if __name__ == "__main__":
    print(test_inference())
