import { spawn } from "node:child_process";

export async function openBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    spawnFn?: typeof spawn;
  } = {}
) {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? spawn;
  const command = resolveOpenCommand(platform, url);

  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(command.file, command.args, {
      stdio: "ignore",
      detached: true
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function resolveOpenCommand(platform: NodeJS.Platform, url: string) {
  if (platform === "darwin") {
    return { file: "open", args: [url] };
  }

  if (platform === "win32") {
    return { file: "cmd", args: ["/c", "start", "", url] };
  }

  return { file: "xdg-open", args: [url] };
}
