// A stand-in for whisper.cpp's whisper-server: same flags, same endpoints.
// A model path containing "crash" exits at once with a CUDA-like stderr line.
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const model = flag("-m");
const port = Number(flag("--port"));
const base = flag("--request-path") ?? "";

if (!args.includes("--suppress-nst") || flag("--host") !== "127.0.0.1" || flag("-l") !== "auto") {
	process.stderr.write(`unexpected args: ${args.join(" ")}\n`);
	process.exit(2);
}
if (model.includes("crash")) {
	process.stderr.write("ggml_cuda_init: CUDA error: no CUDA-capable device is detected\n");
	process.exit(3);
}

http.createServer((req, res) => {
	if (req.method === "GET" && req.url === `${base}/health`) {
		res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
		return;
	}
	if (req.method === "POST" && req.url === `${base}/inference`) {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("latin1");
			const language = /name="language"\r\n\r\n([^\r]*)/.exec(body)?.[1];
			const hasWav = body.includes("RIFF") && body.includes('filename="dictation.wav"');
			if (!hasWav) {
				res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"no \'file\' field in the request"}');
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: ` [BLANK_AUDIO] hello  there (${language}) ` }));
		});
		return;
	}
	res.writeHead(404).end();
}).listen(port, "127.0.0.1");
