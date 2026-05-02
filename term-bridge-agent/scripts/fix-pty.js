const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const pkgDir = path.join(__dirname, "..");
const ptyDir = path.join(pkgDir, "node_modules", "node-pty");

if (!fs.existsSync(ptyDir)) {
  process.exit(0);
}

try {
  execSync("chmod +x node_modules/node-pty/prebuilds/*/spawn-helper", {
    stdio: "ignore",
    cwd: pkgDir,
  });
  execSync("xattr -dr com.apple.quarantine node_modules/node-pty", {
    stdio: "ignore",
    cwd: pkgDir,
  });
  execSync(
    'find node_modules/node-pty -name "*.node" -exec codesign --force --sign - {} \\;',
    { stdio: "ignore", cwd: pkgDir }
  );
  execSync(
    "codesign --force --sign - node_modules/node-pty/prebuilds/*/spawn-helper",
    { stdio: "ignore", cwd: pkgDir }
  );
} catch (e) {}
