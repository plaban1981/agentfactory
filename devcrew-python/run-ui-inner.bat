@echo off
cd /d C:\Users\nayak\Documents\kimi\workspace\devcrew-python
"C:\Users\nayak\AppData\Local\Programs\Python\Python312\python.exe" -m uvicorn devcrew.ui.app:app --port 8017 --app-dir C:\Users\nayak\Documents\kimi\workspace\devcrew-python > "C:\Users\nayak\Documents\kimi\workspace\devcrew-python\ui-server.log" 2>&1
