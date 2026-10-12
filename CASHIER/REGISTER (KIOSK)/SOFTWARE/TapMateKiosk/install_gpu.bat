@echo off
cd /d "%~dp0"
echo Replacing CPU-only PyTorch with the NVIDIA CUDA build (RTX 30/40 series) ...
python -m pip uninstall -y torch torchvision torchaudio
python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
if errorlevel 1 (
  echo.
  echo CUDA install failed. Check the internet connection and the messages above, then run this again.
  pause
  exit /b 1
)
echo.
echo Checking the GPU ...
python -c "import torch; print('torch', torch.__version__, '| CUDA available:', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no GPU found')"
echo.
echo If it says CUDA available: True, you are done. Start the kiosk as usual.
echo If it says False, update your NVIDIA driver (GeForce Experience or nvidia.com/drivers) and run this again.
pause
