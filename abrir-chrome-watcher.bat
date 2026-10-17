@echo off
REM Abre o Chrome em modo depuracao para o watcher de codigos.
REM Deixe esta janela do Chrome aberta enquanto o watcher estiver rodando.
cd /d "%~dp0"
node watcher.js chrome
