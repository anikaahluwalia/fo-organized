import zlib from "node:zlib";

/**
 * Best-effort text from simple PDFs: literal and hex strings shown with Tj/TJ/'/" in plain or
 * Flate-compressed content streams. Returns null when nothing readable is found (scans, CID
 * fonts, unusual encodings). Used to check quotes against the document and for mock reading.
 */
export function pdfText(buf: Buffer): string | null {
  const src = buf.toString("latin1");
  const parts: string[] = [];
  const streamRe = /<<((?:(?!>>)[\s\S])*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(src))) {
    const dict = m[1] ?? "";
    const start = m.index + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end === -1) break;
    streamRe.lastIndex = end;
    let data = Buffer.from(src.slice(start, end).replace(/\r?\n$/, ""), "latin1");
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue;
    const text = textFromContent(data.toString("latin1"));
    if (text.trim()) parts.push(text);
  }
  const text = parts.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || null;
}

function readLiteral(s: string, i: number): [string, number] {
  let depth = 1;
  let out = "";
  i++;
  while (i < s.length && depth > 0) {
    const c = s[i]!;
    if (c === "\\") {
      const n = s[i + 1] ?? "";
      const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (n in map) {
        out += map[n];
        i += 2;
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
        out += String.fromCharCode(parseInt(oct, 8));
        i += 1 + oct.length;
      } else {
        i += 2;
      }
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth > 0) out += c;
    i++;
  }
  return [out, i];
}

function textFromContent(s: string): string {
  let out = "";
  const stack: (string | string[])[] = [];
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(") {
      const [str, next] = readLiteral(s, i);
      stack.push(str);
      i = next;
    } else if (c === "[") {
      const items: string[] = [];
      i++;
      while (i < s.length && s[i] !== "]") {
        if (s[i] === "(") {
          const [str, next] = readLiteral(s, i);
          items.push(str);
          i = next;
        } else {
          const num = /^-?\d+(\.\d+)?/.exec(s.slice(i));
          if (num) {
            if (Number(num[0]) < -200) items.push(" ");
            i += num[0].length;
          } else i++;
        }
      }
      stack.push(items);
      i++;
    } else if (c === "<" && s[i + 1] !== "<") {
      const end = s.indexOf(">", i);
      const hex = s.slice(i + 1, end === -1 ? s.length : end).replace(/\s/g, "");
      stack.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex").toString("latin1"));
      i = end === -1 ? s.length : end + 1;
    } else {
      const tok = /^[^\s()<>\[\]{}\/%]+|^./.exec(s.slice(i))![0];
      i += tok.length;
      const last = stack[stack.length - 1];
      if (tok === "Tj" && typeof last === "string") out += last;
      else if (tok === "TJ" && Array.isArray(last)) out += last.join("");
      else if ((tok === "'" || tok === '"') && typeof last === "string") {
        newline();
        out += last;
      } else if (tok === "T*" || tok === "Td" || tok === "TD" || tok === "Tm" || tok === "ET") newline();
      if (/^[A-Za-z'"*]+$/.test(tok)) stack.length = 0;
    }
  }
  return out;
}
