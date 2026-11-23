@echo off
chcp 65001 >nul
echo ============================================================
echo   토목기사 CBT 120제 (초등학생 쉬운 풀이 + 다정한 AI 음성)
echo   http://localhost:8120/ 에서 열립니다...
echo ============================================================
start "" "http://localhost:8120/"
"C:\Users\Desktop\AppData\Local\Programs\Python\Python314\python.exe" "%~dp0server.py"
pause
