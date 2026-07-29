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

function Get-GraphValue {
    param(
        [Parameter(Mandatory = $true)]
        [object]$User,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    $property = $User.PSObject.Properties[$PropertyName]
    if ($null -ne $property -and $null -ne $property.Value) {
        return $property.Value
    }

    if ($User.AdditionalProperties -is [System.Collections.IDictionary] -and $User.AdditionalProperties.ContainsKey($PropertyName)) {
        return $User.AdditionalProperties[$PropertyName]
    }

    return $null
}

function Get-PrimarySmtp {
    param([string[]]$ProxyAddresses)

    if ($null -eq $ProxyAddresses) {
        return ''
    }

    $primary = $ProxyAddresses | Where-Object { $_ -like 'SMTP:*' } | Select-Object -First 1
    if (-not $primary) {
        return ''
    }

    return $primary.Substring(5)
}

$records = @(
    Get-MgUser -All -Property Id, UserPrincipalName, DisplayName, ProxyAddresses, extension_c77e68a23a6a4f91af48a93b63f95e0f_AMCOMPANYCODE, extension_c77e68a23a6a4f91af48a93b63f95e0f_AMBUCODE, extension_c77e68a23a6a4f91af48a93b63f95e0f_AMSEGMENTCODE |
        Where-Object { $_.Id -and $_.UserPrincipalName } |
        ForEach-Object {
            $amCompanyCode = Get-GraphValue -User $_ -PropertyName 'extension_c77e68a23a6a4f91af48a93b63f95e0f_AMCOMPANYCODE'
            $amBuCode = Get-GraphValue -User $_ -PropertyName 'extension_c77e68a23a6a4f91af48a93b63f95e0f_AMBUCODE'
            $amSegmentCode = Get-GraphValue -User $_ -PropertyName 'extension_c77e68a23a6a4f91af48a93b63f95e0f_AMSEGMENTCODE'
            $smtp = Get-PrimarySmtp -ProxyAddresses $_.ProxyAddresses

            [ordered]@{
                id                = $_.Id
                userPrincipalName = $_.UserPrincipalName
                displayName       = $_.DisplayName
                extension_c77e68a23a6a4f91af48a93b63f95e0f_AMCOMPANYCODE = if ($null -eq $amCompanyCode) { '' } else { [string]$amCompanyCode }
                extension_c77e68a23a6a4f91af48a93b63f95e0f_AMBUCODE = if ($null -eq $amBuCode) { '' } else { [string]$amBuCode }
                extension_c77e68a23a6a4f91af48a93b63f95e0f_AMSEGMENTCODE = if ($null -eq $amSegmentCode) { '' } else { [string]$amSegmentCode }
                SMTP              = $smtp
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