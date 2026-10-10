@echo off
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.10 or newer and tick "Add python.exe to PATH", then run this again.
  pause
  exit /b 1
)

echo Installing packages: PySide6, OpenCV, ultralytics, requests, pyserial, segno ...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo Package install failed. Check the internet connection and the messages above, then run this again.
  pause
  exit /b 1
)

echo.
echo Allowing the phone link through Windows Firewall ^(private networks, port 8765^) ...
netsh advfirewall firewall delete rule name="TapMate Kiosk phone link" >nul 2>nul
netsh advfirewall firewall add rule name="TapMate Kiosk phone link" dir=in action=allow protocol=TCP localport=8765 profile=private >nul 2>nul
if errorlevel 1 (
  echo Could not add the firewall rule. That needs "Run as administrator".
  echo It is not required: Windows will ask the first time the kiosk starts. Tick "Private networks" and allow it.
)

python main.py --register
echo.
echo Done.
echo - Put your trained weights at models\best.pt
echo - If you changed phone.port in config.json, allow that port in the firewall instead of 8765
echo - Then click "Open Cashier kiosk" on the Register page
pause