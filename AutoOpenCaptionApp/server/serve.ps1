param(
    [int]$Port = 8743,
    [string]$Root = "$PSScriptRoot\..\app"
)

$listener = New-Object System.Net.HttpListener

try {
    $listener.Prefixes.Add("http://localhost:$Port/")
    try {
        # Also answer http://127.0.0.1:$Port/ (http.sys rejects that host as
        # 400 Bad Request when only "localhost" is registered). Non-fatal.
        $listener.Prefixes.Add("http://127.0.0.1:$Port/")
    } catch {}
    $listener.Start()
} catch [System.Net.HttpListenerException] {
    Write-Host ""
    Write-Host "ERROR: Could not start the server on port $Port." -ForegroundColor Red
    Write-Host "If AutoOpenCaption is already running in another window, just open" -ForegroundColor Yellow
    Write-Host "http://localhost:$Port in your browser instead." -ForegroundColor Yellow
    Write-Host "Otherwise close the other program using port $Port and try again." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "AutoOpenCaption server running on http://localhost:$Port" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

$mimeTypes = @{
    ".html" = "text/html"
    ".css"  = "text/css"
    ".js"   = "application/javascript"
    ".mjs"  = "application/javascript"
    ".json" = "application/json"
    ".wasm" = "application/wasm"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
    ".mp4"  = "video/mp4"
    ".webm" = "video/webm"
    ".woff" = "font/woff"
    ".woff2"= "font/woff2"
    ".ttf"  = "font/ttf"
    ".otf"  = "font/otf"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        # One malformed or aborted request must never take the whole server
        # down: handle each request inside its own try/catch.
        try {
            $request = $context.Request
            $response = $context.Response
            $method = $request.HttpMethod

            # CORS and security headers
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            $response.Headers.Add("Access-Control-Allow-Headers", "*")
            $response.Headers.Add("Cross-Origin-Opener-Policy", "same-origin")
            $response.Headers.Add("Cross-Origin-Embedder-Policy", "credentialless")
            $response.Headers.Add("Accept-Ranges", "bytes")

            $localPath = $request.Url.LocalPath
            if ($localPath -eq "/") { $localPath = "/index.html" }
            if ($localPath -eq "/favicon.ico") {
                $response.StatusCode = 204
                $response.OutputStream.Close()
                continue
            }

            $filePath = Join-Path $Root ($localPath.TrimStart("/").Replace("/", "\"))

            if (Test-Path $filePath -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }

                $response.ContentType = $contentType
                $buffer = [System.IO.File]::ReadAllBytes($filePath)
                $response.ContentLength64 = $buffer.Length
                # HEAD requests must not send a body, or HttpListener throws
                # ProtocolViolationException and the loop dies.
                if ($method -eq "GET") {
                    $response.OutputStream.Write($buffer, 0, $buffer.Length)
                }
            } else {
                $response.StatusCode = 404
                $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                if ($method -eq "GET") {
                    $response.OutputStream.Write($msg, 0, $msg.Length)
                }
            }

            $response.OutputStream.Close()
        } catch {
            Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor DarkGray
            try { $context.Response.Abort() } catch {}
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
    Write-Host "Server stopped." -ForegroundColor Red
}