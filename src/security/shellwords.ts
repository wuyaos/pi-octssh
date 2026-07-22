export function splitShellWords(input: string) {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let mode: "none" | "single" | "double" = "none";

  const push = () => {
    if (cur.length) out.push(cur);
    cur = "";
  };

  while (i < input.length) {
    const ch = input[i];

    if (mode === "none") {
      if (ch === "'") {
        mode = "single";
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "double";
        i++;
        continue;
      }
      if (/\s/.test(ch)) {
        push();
        i++;
        continue;
      }
      if (ch === "\\") {
        // Simple escape.
        const next = input[i + 1];
        if (next !== undefined) {
          cur += next;
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    if (mode === "single") {
      if (ch === "'") {
        mode = "none";
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    // double
    if (ch === '"') {
      mode = "none";
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next !== undefined) {
        cur += next;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    cur += ch;
    i++;
  }

  push();
  return out;
}
