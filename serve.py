"""Dev server: no caching for code, long caching for the WebAssembly client.

`python -m http.server` sends no Cache-Control header, so browsers may reuse a stale
JS file after an edit (new HTML, old app.js). The replay client is the opposite case:
`/client/DDNet.*` is ~51 MB and must be downloaded once, then kept.

The COOP/COEP headers make the page cross-origin isolated, which the threaded
WebAssembly client needs for SharedArrayBuffer. On hosts that cannot set headers,
the root `coi-serviceworker.js` does the same job from a service worker.
"""
import mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".data")


class ReplayHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")

        path = self.path.split("?", 1)[0]
        if path.startswith("/client/DDNet."):
            # Build outputs never change for a given filename.
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif path == "/coi-serviceworker.js":
            # The browser has to be able to notice updates to the worker itself.
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Starting server at http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), ReplayHandler).serve_forever()
