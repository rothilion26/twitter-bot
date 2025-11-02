# bootstrap.ps1 - tek komutla hazırlık
Set-StrictMode -Version Latest
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Working dir: $here"

# 1) Node kontrol
function Ensure-Node {
  try {
    $v = & node -v 2>$null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Node bulundu: $v"
      return
    }
  } catch {}
  Write-Host "Node bulunamadı. winget ile Node LTS kuruluyor..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Write-Host "winget kurulum başarısız. Lütfen manuel kur: https://nodejs.org"; exit 1 }
  } else {
    Write-Host "Winget bulunamadı. Lütfen Node.js LTS manuel kur: https://nodejs.org"
    Start-Process "https://nodejs.org" -UseNewWindow
    exit 1
  }
}

# 2) Proje hazırlık
function Setup-Project {
  Push-Location $here
  Write-Host "npm install çalıştırılıyor..."
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Host "npm install başarısız"; exit 1 }

  Write-Host "Playwright browser kuruluyor (chromium)... Bu biraz zaman alabilir."
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { Write-Host "Playwright install başarısız"; exit 1 }

  # .env kontrol / kopyala
  if (-not (Test-Path ".env")) {
    Copy-Item .env.example .env
    Write-Host ".env oluşturuldu (varsayılan değerler). Lütfen .env düzenle (ör: STORAGE_STATE, INPUT_FILE)."
  } else {
    Write-Host ".env zaten var."
  }
  Pop-Location
}

# 3) Save-session çağrısı (kullanıcı müdahalesi gerektirir)
function Run-SaveSession {
  Push-Location $here
  Write-Host "Tarayıcı açılacak. Lütfen X/Twitter hesabına giriş yapın, sonra terminale ENTER basın."
  cmd /c "npm run save-session"
  Pop-Location
}

# 4) Kısayol oluştur (run_bot.bat) - zaten varsa overwrite etme
function Ensure-RunBatch {
  $bat = Join-Path $here "run_bot.bat"
  $content = "@echo off`ncd /d %~dp0`nnode src\bot.js %*`npause"
  Set-Content -Path $bat -Value $content -Encoding ASCII
  Write-Host "run_bot.bat oluşturuldu. Bot'u bu dosyaya çift tıklayarak başlatabilirsiniz."
}

# Execute
Ensure-Node
Setup-Project
Ensure-RunBatch

Write-Host "`nYapılacaklar:"
Write-Host "1) npm run save-session ile tarayıcıda giriş yapın ve ENTER'a basın."
Write-Host "2) Ardından run_bot.bat dosyasına çift tıklayın veya 'run_bot.bat --tweets=3' şeklinde çalıştırın."
Write-Host ""
