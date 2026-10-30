@echo off
cd /d "%~dp0"
echo Starting server at http://localhost:8000
python serve.py
pause
