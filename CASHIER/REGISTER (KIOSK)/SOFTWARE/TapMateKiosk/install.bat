@echo off
cd /d "%~dp0"
python -m pip install -r requirements.txt
python main.py --register
echo.
echo Done. Put your trained weights at models\best.pt, then click "Open Cashier kiosk" on the Register page.
pause
