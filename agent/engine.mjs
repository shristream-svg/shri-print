import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const exec = promisify(execFile);
function sanitizedEnv() {
  const env = { ...process.env };
  delete env.PSModulePath;
  return env;
}
export async function inventory() {
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$items = @(Get-Printer | ForEach-Object {
  $printer = $_
  $details = @{Name=$printer.Name; PrinterStatus=$printer.PrinterStatus.ToString(); DriverName=$printer.DriverName}
  try { $settings = New-Object System.Drawing.Printing.PrinterSettings; $settings.PrinterName=$printer.Name; $details.CanDuplex=$settings.CanDuplex; $details.SupportsColor=$settings.SupportsColor; $details.PaperSizes=@($settings.PaperSizes | ForEach-Object { $_.PaperName }) } catch {}
  [pscustomobject]$details
})
ConvertTo-Json -InputObject $items -Depth 4 -Compress`;
  const { stdout } = await exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: sanitizedEnv() }
  );
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}
export function printArgs(job, file) {
  const o = job.options;
  if (
    !['bw', 'color'].includes(o.color) ||
    !['A4', 'A3', 'A2', 'A1'].includes(o.paper) ||
    !Number.isInteger(o.copies) ||
    o.copies < 1 ||
    o.copies > 100 ||
    !['portrait', 'landscape'].includes(o.orientation) ||
    typeof o.duplex !== 'boolean'
  )
    throw new Error('Invalid print settings.');
  return [
    '-print-to',
    job.printer,
    '-print-settings',
    [
      o.copies + 'x',
      o.color === 'color' ? 'color' : 'monochrome',
      o.duplex ? 'duplexlong' : 'simplex',
      o.orientation,
      'paper=' + o.paper,
      ['id', 'passport'].includes(o.service) ? 'noscale' : 'fit',
      'collate',
      'ignore-pdf-print-settings',
    ].join(','),
    '-silent',
    file,
  ];
}
export async function printDocument(engine, job, file, printers) {
  const printer = printers.find(p => p.Name === job.printer);
  if (!printer) throw new Error('Mapped Windows printer was not found. Check its exact name.');
  if (/offline|error|paperout|notavailable|dooropen|tonerlow/i.test(printer.PrinterStatus))
    throw new Error(
      'Windows reports printer ' + printer.PrinterStatus + '. Check the printer before retrying.'
    );
  if (/Microsoft Print to PDF|OneNote|XPS|Fax/i.test(job.printer))
    throw new Error('An interactive virtual printer cannot be used for unattended shop printing.');
  if (job.options.duplex && printer.CanDuplex === false)
    throw new Error(
      'The mapped Windows printer does not support automatic duplex. Select single sided.'
    );
  if (job.options.color === 'color' && printer.SupportsColor === false)
    throw new Error('The mapped printer does not support color.');
  if (
    printer.PaperSizes?.length &&
    !printer.PaperSizes.some(size =>
      new RegExp('(^|[^a-z0-9])' + job.options.paper + '([^0-9]|$)', 'i').test(size)
    )
  )
    throw new Error(
      'The mapped printer does not support ' + job.options.paper + '. Select supported paper.'
    );
  await exec(engine, printArgs(job, file), {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: sanitizedEnv(),
  });
}
