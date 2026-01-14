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
};

export type TaskListState = {
  title: string;
  items: TaskItem[];
  headerError?: {
    message: string;
    code?: string;
  } | null;
};

export type OrderedSetEntry<TData> = {
  id: string;
  pos: Position | null;
  data: TData;
  createdAt?: number | null;
  updatedAt?: number | null;
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

export type ListState = OrderedSetState<{ text: string; done: boolean }> & {
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
  afterId?: ItemId | null;
  beforeId?: ItemId | null;
  position?: Position | null;
};

export type TaskUpdateInput = {
  text?: string | null;
  done?: boolean | null;
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
