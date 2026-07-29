const D1_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonValueEnd(source, start) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const opening = stack.pop();
      if (
        (character === "}" && opening !== "{") ||
        (character === "]" && opening !== "[")
      ) {
        return -1;
      }
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

export function parseWranglerJson(output, label = "Wrangler") {
  const source = String(output);
  const candidates = source.matchAll(/(?:^|\n)[\t ]*([\[{])/g);
  for (const candidate of candidates) {
    const opening = candidate[1];
    const start = (candidate.index ?? 0) + candidate[0].lastIndexOf(opening);
    const end = jsonValueEnd(source, start);
    if (end < 0) continue;
    try {
      return JSON.parse(source.slice(start, end));
    } catch {
      // Keep looking in case a warning contained JSON-like text.
    }
  }
  throw new Error(`${label} 已响应，但没有返回可识别的 JSON。`);
}

export function findD1DatabaseByName(databases, name) {
  if (!Array.isArray(databases)) {
    throw new Error("Wrangler 返回的 D1 数据库清单格式不正确。");
  }
  const database = databases.find(
    (entry) => entry && typeof entry === "object" && entry.name === name,
  );
  if (!database) return null;
  const id = database.uuid ?? database.database_id ?? database.id;
  if (typeof id !== "string" || !D1_ID_PATTERN.test(id)) {
    throw new Error(`找到了资料数据库 ${name}，但无法读取它的数据库编号。`);
  }
  return { id, name };
}
