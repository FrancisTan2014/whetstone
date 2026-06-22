@echo off
setlocal

schtasks /Delete /TN "whetstone-developer" /F
schtasks /Delete /TN "whetstone-reviewer" /F
