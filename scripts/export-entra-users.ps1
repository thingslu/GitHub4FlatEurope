[CmdletBinding()]
param(
    [string]$OutputPath = './input/entra-users.json'
)

$ErrorActionPreference = 'Stop'

$missingCommands = @('Connect-MgGraph', 'Get-MgUser') |
    Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }

if ($missingCommands.Count -gt 0) {
    throw 'Microsoft Graph PowerShell is required. Run: Install-Module Microsoft.Graph.Authentication,Microsoft.Graph.Users -Scope CurrentUser'
}

Connect-MgGraph -Scopes 'User.Read.All' -ContextScope Process -NoWelcome

$records = @(
    Get-MgUser -All -Property Id, UserPrincipalName, DisplayName |
        Where-Object { $_.Id -and $_.UserPrincipalName } |
        ForEach-Object {
            [ordered]@{
                id                = $_.Id
                userPrincipalName = $_.UserPrincipalName
                displayName       = $_.DisplayName
            }
        }
)

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($resolvedOutputPath)
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$json = ConvertTo-Json -InputObject $records -Depth 3
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($resolvedOutputPath, $json, $utf8WithoutBom)

Write-Host "Exported $($records.Count) Entra users to $resolvedOutputPath"