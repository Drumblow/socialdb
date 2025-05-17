# Script para testar a aplicação P2P social-app-core.js

Write-Host "Iniciando script de teste P2P..." -ForegroundColor Yellow

# --- Configuração ---
$Node1DataDir = ".\data\node1"
$Node2DataDir = ".\data\node2"
$Node1Port = "9001"
$Node2Port = "9002"
$NodeScriptPath = ".\src\index.js" # Caminho para o script Node.js
$LogDir = ".\logs" # Diretório para logs
$Node1LogFile = Join-Path $LogDir "node1.log"
$Node2LogFile = Join-Path $LogDir "node2.log"
$InitialWaitSeconds = 10 # Tempo para o Nó 1 inicializar e logar o PeerID
$PeerIdExtractionAttempts = 5
$PeerIdExtractionRetryDelaySeconds = 5
$TestRunDurationSeconds = 100 # Duração total do teste após o Nó 2 iniciar

$Global:Node1Process = $null
$Global:Node2Process = $null

# --- Funções Auxiliares ---
Function Stop-NodeProcessesAtExit {
    Write-Host "Encerrando processos dos nós (se estiverem rodando)..." -ForegroundColor Cyan
    if ($Global:Node1Process -and -not $Global:Node1Process.HasExited) {
        Write-Host "Parando Nó 1 (PID: $($Global:Node1Process.Id))..."
        Stop-Process -Id $Global:Node1Process.Id -Force -ErrorAction SilentlyContinue
    }
    if ($Global:Node2Process -and -not $Global:Node2Process.HasExited) {
        Write-Host "Parando Nó 2 (PID: $($Global:Node2Process.Id))..."
        Stop-Process -Id $Global:Node2Process.Id -Force -ErrorAction SilentlyContinue
    }
    # Considerar uma limpeza mais genérica se PIDs não forem capturados
    # Get-Process | Where-Object {$_.ProcessName -eq "node" -and $_.Path -like "*$NodeScriptPath*"} | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Registrar evento para limpar processos ao sair do script (Ctrl+C, erro, etc.)
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Stop-NodeProcessesAtExit } | Out-Null


# --- Preparação ---
Write-Host "Limpando diretórios de dados e logs antigos..." -ForegroundColor Green
# Criar diretório de dados base se não existir
if (-not (Test-Path ".\data")) { New-Item -ItemType Directory -Path ".\data" | Out-Null }

# Limpar subdiretórios datastore e arquivos peer.key legados
if (Test-Path (Join-Path $Node1DataDir "datastore")) { Remove-Item -Recurse -Force (Join-Path $Node1DataDir "datastore") }
if (Test-Path (Join-Path $Node2DataDir "datastore")) { Remove-Item -Recurse -Force (Join-Path $Node2DataDir "datastore") }
if (Test-Path (Join-Path $Node1DataDir "peer.key")) { Remove-Item -Force (Join-Path $Node1DataDir "peer.key") }
if (Test-Path (Join-Path $Node2DataDir "peer.key")) { Remove-Item -Force (Join-Path $Node2DataDir "peer.key") }

# Limpar e recriar diretório de logs
if (Test-Path $LogDir) { Remove-Item -Recurse -Force $LogDir }
New-Item -ItemType Directory -Path $LogDir -ErrorAction SilentlyContinue | Out-Null


# --- Iniciar Nó 1 ---
Write-Host "Iniciando Nó 1..." -ForegroundColor Green
$env:DATA_DIR = $Node1DataDir
$env:WS_PORT = $Node1Port
$env:QUERY_TARGET_PEER_ID = ""
$env:BOOTSTRAP_PEER = ""

try {
    $Global:Node1Process = Start-Process node -ArgumentList $NodeScriptPath -PassThru -RedirectStandardOutput $Node1LogFile -WindowStyle Minimized
    If (-not $Global:Node1Process) { throw "Falha ao obter o objeto do processo para o Nó 1." }
    Write-Host "Nó 1 iniciado (PID: $($Global:Node1Process.Id)). Aguardando $InitialWaitSeconds segundos para inicialização..."
    Start-Sleep -Seconds $InitialWaitSeconds
} catch {
    Write-Error "Erro crítico ao iniciar o Nó 1: $_"
    Write-Error "Verifique o log: $Node1LogFile (se existir)"
    if(Test-Path $Node1LogFile){ Get-Content $Node1LogFile -Tail 30 | ForEach-Object { Write-Error $_ }}
    exit 1
}

# --- Extrair Peer ID do Nó 1 ---
Write-Host "Extraindo Peer ID do Nó 1 de $Node1LogFile..." -ForegroundColor Cyan
$Node1PeerId = $null
for ($attempt = 1; $attempt -le $PeerIdExtractionAttempts; $attempt++) {
    if ($Global:Node1Process.HasExited) {
        Write-Error "Nó 1 terminou inesperadamente antes que o PeerID pudesse ser extraído."
        Get-Content $Node1LogFile -Tail 30 | ForEach-Object { Write-Error $_ }
        break 
    }
    if (Test-Path $Node1LogFile) {
        $PeerIdLine = Get-Content $Node1LogFile | Select-String -Pattern "CORE: Nó Helia \(e Libp2p\) iniciado com Peer ID: (12D3KooW[a-zA-Z0-9]+)" -ErrorAction SilentlyContinue
        if ($PeerIdLine) {
            $Node1PeerId = $PeerIdLine.Matches[0].Groups[1].Value
            Write-Host "Peer ID do Nó 1 encontrado: $Node1PeerId" -ForegroundColor Green
            break
        }
    }
    if (-not $Node1PeerId) {
        Write-Warning "Peer ID do Nó 1 ainda não encontrado (tentativa $attempt/$PeerIdExtractionAttempts). Aguardando mais $PeerIdExtractionRetryDelaySeconds segundos..."
        Start-Sleep -Seconds $PeerIdExtractionRetryDelaySeconds
    }
}

if (-not $Node1PeerId) {
    Write-Error "Não foi possível extrair o Peer ID do Nó 1 de $Node1LogFile após $PeerIdExtractionAttempts tentativas."
    Write-Error "Últimas linhas do Log do Nó 1:"
    if(Test-Path $Node1LogFile){ Get-Content $Node1LogFile -Tail 30 | ForEach-Object { Write-Error $_ } }
    Stop-NodeProcessesAtExit # Tenta parar o Nó 1 se ele ainda estiver rodando
    exit 1
}

# --- Iniciar Nó 2 ---
Write-Host "Iniciando Nó 2..." -ForegroundColor Green
$env:DATA_DIR = $Node2DataDir
$env:WS_PORT = $Node2Port
$env:QUERY_TARGET_PEER_ID = $Node1PeerId
$env:BOOTSTRAP_PEER = "/ip4/127.0.0.1/tcp/$($Node1Port)/ws/p2p/$($Node1PeerId)"

Write-Host "  Usando QUERY_TARGET_PEER_ID: $Node1PeerId"
Write-Host "  Usando BOOTSTRAP_PEER: $($env:BOOTSTRAP_PEER)"

try {
    $Global:Node2Process = Start-Process node -ArgumentList $NodeScriptPath -PassThru -RedirectStandardOutput $Node2LogFile -WindowStyle Minimized
    If (-not $Global:Node2Process) { throw "Falha ao obter o objeto do processo para o Nó 2." }
    Write-Host "Nó 2 iniciado (PID: $($Global:Node2Process.Id))."
} catch {
    Write-Error "Erro crítico ao iniciar o Nó 2: $_"
    Write-Error "Verifique o log: $Node2LogFile (se existir)"
    if(Test-Path $Node2LogFile){ Get-Content $Node2LogFile -Tail 30 | ForEach-Object { Write-Error $_ }}
    Stop-NodeProcessesAtExit 
    exit 1
}

# --- Monitorar/Aguardar Conclusão ---
Write-Host "Teste em execução. Aguardando $TestRunDurationSeconds segundos para a conclusão..." -ForegroundColor Cyan
Start-Sleep -Seconds $TestRunDurationSeconds

# --- Finalização ---
Write-Host "Tempo de teste concluído." -ForegroundColor Yellow
Stop-NodeProcessesAtExit

Write-Host "--- Conteúdo do Log do Nó 1 ($Node1LogFile) ---" -ForegroundColor Magenta
if(Test-Path $Node1LogFile) { Get-Content $Node1LogFile } else { Write-Warning "Arquivo de log $Node1LogFile não encontrado."}

Write-Host "--- Conteúdo do Log do Nó 2 ($Node2LogFile) ---" -ForegroundColor Magenta
if(Test-Path $Node2LogFile) { Get-Content $Node2LogFile } else { Write-Warning "Arquivo de log $Node2LogFile não encontrado."}

Write-Host "Script de teste P2P concluído." -ForegroundColor Yellow