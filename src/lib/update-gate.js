export const UPDATE_REQUIRED_HEADER = "x-omnirush-update-required";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseUpdateHeader(value) {
  if (typeof value !== "string") return null;
  const [head, ...params] = value.split(";").map((part) => part.trim());
  if (!VERSION_PATTERN.test(head)) return null;
  let deadline = null;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq <= 0 || param.slice(0, eq).trim().toLowerCase() !== "deadline") continue;
    const at = Date.parse(param.slice(eq + 1).trim().replace(/^"|"$/g, ""));
    if (Number.isFinite(at)) deadline = new Date(at).toISOString();
  }
  return { minimum: head, deadline };
}

export function updateRequiredError(status, payload) {
  const error = payload && typeof payload === "object" && payload.error && typeof payload.error === "object"
    ? payload.error
    : payload;
  const code = typeof error?.code === "string"
    ? error.code
    : typeof error?.type === "string"
      ? error.type
      : "";
  if (status !== 426 && code !== "update_required") return null;
  return {
    minimum: typeof error?.minimum === "string" ? error.minimum.trim() : "",
    message: typeof error?.message === "string" ? error.message.trim() : "",
  };
}
