/** Все пути к файлам пакета из полей package.json (main, module, types, exports). */
export function packagePaths(pkg) {
  const paths = [pkg.main, pkg.module, pkg.types].filter(Boolean);
  const walk = (node) => {
    if (typeof node === "string") paths.push(node);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(pkg.exports);
  return [...new Set(paths)];
}
