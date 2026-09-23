Add-Type -AssemblyName System.Speech
$lines = Get-Content -Raw -Encoding UTF8 "lines.json" | ConvertFrom-Json
New-Item -ItemType Directory -Force "audio" | Out-Null
foreach ($l in $lines) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice("Microsoft " + $l[1] + " Desktop")
  $s.Rate = $(if ($l[1] -eq "David") { 1 } else { 0 })
  $s.SetOutputToWaveFile((Join-Path (Get-Location) ("audio\" + $l[0] + ".wav")))
  $s.Speak($l[2])
  $s.Dispose()
}
Get-ChildItem audio | ForEach-Object { "{0} {1}" -f $_.Name, $_.Length }
