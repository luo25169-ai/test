export function getDatabaseStatus() {
  return {
    provider: "sqlite",
    ready: false,
    message: "Prisma schema is scaffolded; migrations will be enabled when persistence is wired into services."
  };
}
