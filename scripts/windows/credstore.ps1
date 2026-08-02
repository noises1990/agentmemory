# Windows Credential Manager helper for agentmemory secrets.
#
# Keeps API tokens out of .env files and out of the repo. Secrets live in
# the OS credential vault (CRED_TYPE_GENERIC), encrypted at rest by DPAPI
# under the current user account, and are visible/removable through
# Control Panel -> Credential Manager -> Windows Credentials.
#
# There is no built-in PowerShell cmdlet for the credential vault, so this
# P/Invokes advapi32 CredRead/CredWrite/CredDelete directly.
#
# Usage:
#   .\credstore.ps1 -Set    -Name agentmemory/CLOUDFLARE_API_TOKEN
#   .\credstore.ps1 -Get    -Name agentmemory/CLOUDFLARE_API_TOKEN
#   .\credstore.ps1 -Delete -Name agentmemory/CLOUDFLARE_API_TOKEN
#   .\credstore.ps1 -List
#
# -Set prompts with a masked field; the token is never echoed, never
# passed as an argument (which would land in shell history and in the
# process command line, readable by any other process on the box).

[CmdletBinding(DefaultParameterSetName = 'Get')]
param(
  [Parameter(ParameterSetName = 'Set')]    [switch]$Set,
  [Parameter(ParameterSetName = 'Get')]    [switch]$Get,
  [Parameter(ParameterSetName = 'Delete')] [switch]$Delete,
  [Parameter(ParameterSetName = 'List')]   [switch]$List,

  [Parameter(ParameterSetName = 'Set',    Mandatory = $true)]
  [Parameter(ParameterSetName = 'Get',    Mandatory = $true)]
  [Parameter(ParameterSetName = 'Delete', Mandatory = $true)]
  [string]$Name
)

$ErrorActionPreference = 'Stop'

if (-not ('AgentMemory.CredStore' -as [type])) {
Add-Type -Namespace AgentMemory -Name CredStore -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
}

[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);

[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredDeleteW(string target, uint type, uint flags);

[DllImport("advapi32.dll", SetLastError = true)]
public static extern void CredFree(IntPtr buffer);
'@
}

# CRED_TYPE_GENERIC. Persist=2 is LOCAL_MACHINE: survives logoff and
# reboot but does not roam to other machines -- correct for a token that
# is scoped to this box.
$CRED_TYPE_GENERIC = 1
$CRED_PERSIST_LOCAL_MACHINE = 2

function Set-Secret([string]$Target) {
  $secure = Read-Host -AsSecureString "Enter value for '$Target' (input hidden)"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }

  if ([string]::IsNullOrWhiteSpace($plain)) { throw "Empty value -- nothing stored." }

  $bytes = [Text.Encoding]::Unicode.GetBytes($plain)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $cred = New-Object AgentMemory.CredStore+CREDENTIAL
    $cred.Type = $CRED_TYPE_GENERIC
    $cred.TargetName = $Target
    $cred.UserName = $env:USERNAME
    $cred.Comment = "agentmemory secret"
    $cred.CredentialBlobSize = $bytes.Length
    $cred.CredentialBlob = $blob
    $cred.Persist = $CRED_PERSIST_LOCAL_MACHINE

    if (-not [AgentMemory.CredStore]::CredWriteW([ref]$cred, 0)) {
      throw "CredWrite failed (win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($blob)
  }
  Write-Host "Stored '$Target' ($($plain.Length) chars) in Windows Credential Manager." -ForegroundColor Green
}

function Get-Secret([string]$Target) {
  $ptr = [IntPtr]::Zero
  if (-not [AgentMemory.CredStore]::CredReadW($Target, $CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    # 1168 = ERROR_NOT_FOUND
    if ($err -eq 1168) { throw "No credential named '$Target'. Store it with: credstore.ps1 -Set -Name $Target" }
    throw "CredRead failed (win32 error $err)"
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgentMemory.CredStore+CREDENTIAL])
    if ($cred.CredentialBlobSize -eq 0) { return "" }
    [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, $cred.CredentialBlobSize / 2)
  } finally {
    [AgentMemory.CredStore]::CredFree($ptr)
  }
}

switch ($PSCmdlet.ParameterSetName) {
  'Set'    { Set-Secret -Target $Name }
  'Get'    { Get-Secret -Target $Name }
  'Delete' {
    if ([AgentMemory.CredStore]::CredDeleteW($Name, $CRED_TYPE_GENERIC, 0)) {
      Write-Host "Deleted '$Name'." -ForegroundColor Green
    } else {
      throw "CredDelete failed (win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
  }
  'List'   { cmdkey /list | Select-String -Pattern "agentmemory" -Context 0,2 }
}
