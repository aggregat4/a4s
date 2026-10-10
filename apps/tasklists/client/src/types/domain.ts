export type ListId = string;
type ItemId = string;

type PositionComponent = {
  digit: number;
  actor: string;
};

export type Position = PositionComponent[];

export type TaskItem = {
  id: ItemId;
  text: string;
  done: boolean;
  note?: string;
};

export type TaskListState = {
  title: string;
  items: TaskItem[];
  headerError?: {
    message: string;
    code?: string;
  } | null;
};

/** A write, ordered by its Lamport clock and then by its actor id. */
export type Version = { clock: number; actor: string };

/**
 * The write that last set each part of an item. Each part is a register of
 * its own, so concurrent changes to different parts all take effect, in
 * whatever order they arrive. A missing version means no write yet.
 */
export type EntryVersions = {
  position: Version;
  fields: Record<string, Version>;
};

export type OrderedSetEntry<TData> = {
  id: string;
  pos: Position | null;
  data: TData;
  versions?: EntryVersions;
  deletedAt?: number | null;
};

export type OrderedSetSnapshot<TData> = Array<OrderedSetEntry<TData>>;

type OrderedSetState<TData> = {
  version?: number;
  clock: number;
  entries: OrderedSetSnapshot<TData>;
};

export type ListRegistryEntry = {
  id: ListId;
  title: string;
  pos?: Position | null;
};

export type RegistryState = OrderedSetState<{ title: string }>;

export type ListState = OrderedSetState<{ text: string; done: boolean; note?: string }> & {
  title: string;
  titleUpdatedAt?: number | null;
};

export type ListCreateInput = {
  listId?: ListId | null;
  title?: string | null;
  items?: TaskItem[] | null;
  position?: Position | null;
  afterId?: ListId | null;
  beforeId?: ListId | null;
};

export type TaskInsertInput = {
  itemId?: ItemId | null;
  text?: string | null;
  done?: boolean | null;
  note?: string | null;
  afterId?: ItemId | null;
  beforeId?: ItemId | null;
  position?: Position | null;
};

export type TaskUpdateInput = {
  text?: string | null;
  done?: boolean | null;
  note?: string | null;
};

export type TaskMoveInput = {
  afterId?: ItemId | null;
  beforeId?: ItemId | null;
  position?: Position | null;
};

export type ListReorderInput = {
  afterId?: ListId | null;
  beforeId?: ListId | null;
  position?: Position | null;
};
