"""Registers tapmate-kiosk:// so the website's "Open Cashier kiosk" button launches this program."""
import os, sys

SCHEME = "tapmate-kiosk"

def _command():
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" "%1"'
    exe = sys.executable
    pyw = os.path.join(os.path.dirname(exe), "pythonw.exe")      # no console window
    if os.path.isfile(pyw):
        exe = pyw
    return f'"{exe}" "{os.path.abspath(sys.argv[0])}" "%1"'

def register():
    if os.name != "nt":
        raise SystemExit("Auto-registration is Windows only. On Linux/macOS register the tapmate-kiosk:// scheme with your OS.")
    import winreg
    root = rf"Software\Classes\{SCHEME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, root) as k:
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, "URL:TapMate Kiosk")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, root + r"\shell\open\command") as k:
        winreg.SetValueEx(k, None, 0, winreg.REG_SZ, _command())
    print("Registered. The Register page can now launch the kiosk.")

def unregister():
    import winreg
    root = rf"Software\Classes\{SCHEME}"
    for sub in (r"\shell\open\command", r"\shell\open", r"\shell", ""):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, root + sub)
        except OSError:
            pass
    print("Unregistered.")
