function Get-FolderStructure {
    param (
        [string]$Path
    )

    $items = Get-ChildItem -Path $Path -Force:$false -ErrorAction SilentlyContinue |
        Where-Object {
            -not $_.Attributes.ToString().Contains("Hidden") -and
            -not $_.Attributes.ToString().Contains("System")
        }

    $structure = @()

    foreach ($item in $items) {
        if ($item.PSIsContainer) {
            $structure += @{
                name = $item.Name
                type = "folder"
                children = Get-FolderStructure -Path $item.FullName
            }
        } else {
            $structure += @{
                name = $item.Name
                type = "file"
            }
        }
    }

    return $structure
}

# Ponto de partida: diretório atual
$root = Get-Location
$structure = Get-FolderStructure -Path $root.Path

# Salva como JSON enxuto
$structure | ConvertTo-Json -Depth 100 | Out-File -Encoding utf8 -FilePath "estrutura_projeto.json"

Write-Host "Estrutura salva em estrutura_projeto.json"
