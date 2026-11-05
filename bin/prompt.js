// Questions at the terminal, typed answers hidden for passwords and keys (so they stay out of the
// screen and the shell history). Without a terminal, answers are read line by line from piped stdin.
import readline from "node:readline";

let piped = null; // lines of a piped stdin, read once

async function pipedLine() {
  if (!piped) {
    piped = [];
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) piped.push(line);
  }
  return piped.length ? piped.shift() : null;
}

function hiddenLine() {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let s = "";
    const done = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); process.stderr.write("\n"); };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") { done(); resolve(s); return; }
        if (c === "\u0003" || c === "\u0004") { done(); reject(new Error("cancelled")); return; } // Ctrl+C, Ctrl+D
        if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
        else if (c >= " ") s += c;
      }
    };
    stdin.on("data", onData);
  });
}

// The answer (trimmed), or null when piped stdin has run out.
export async function ask(question, { hidden = false } = {}) {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    const line = await pipedLine();
    process.stderr.write("\n");
    return line?.trim() ?? null;
  }
  if (hidden) return (await hiddenLine()).trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try { return (await new Promise((resolve) => rl.question("", resolve))).trim(); } finally { rl.close(); }
}
