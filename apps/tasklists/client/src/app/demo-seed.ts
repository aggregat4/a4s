import type { ListRepository } from "./list-repository.js";
import type { TaskItem } from "../types/domain.js";

export type SeedConfig = {
  id?: string;
  title?: string;
  items?: TaskItem[];
};

export async function ensureDemoData(
  repository: ListRepository | null,
  seedConfigs: SeedConfig[] | undefined
) {
  if (!repository || typeof repository.initialize !== "function") {
    return false;
  }
  await repository.initialize();
  if (!Array.isArray(seedConfigs) || !seedConfigs.length) {
    return false;
  }
  if (
    typeof repository.getListIds === "function" &&
    repository.getListIds().length
  ) {
    return false;
  }
  let previousId = null;
  for (const config of seedConfigs) {
    const listId =
      typeof config.id === "string" && config.id.length
        ? config.id
        : `seed-${crypto.randomUUID()}`;
    await repository.createList({
      listId,
      title: config.title,
      items: Array.isArray(config.items) ? config.items : [],
      afterId: previousId,
    });
    previousId = listId;
  }
  return true;
}
