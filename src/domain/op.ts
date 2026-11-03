import type {
  FolderPaint,
  FolderPatch,
  ItemPatch,
  LinkKind,
  NewItem,
  Priority,
  RecurrenceFreq,
  StatusMeaning,
  ViewQuery,
} from "./types.ts";

export type Op =
  | {
      type: "createFolder";
      id: string;
      parentId: string | null;
      name: string;
      icon: string | null;
      color: FolderPaint | null;
      statusIds: { todo: string; doing: string; done: string };
    }
  | { type: "updateFolder"; id: string; patch: FolderPatch }
  | {
      type: "moveFolder";
      id: string;
      parentId: string | null;
      sortOrder: string;
    }
  | { type: "deleteFolder"; id: string }
  | { type: "restoreFolder"; id: string }
  | {
      type: "createStatus";
      id: string;
      folderId: string;
      name: string;
      meaning: StatusMeaning;
    }
  | { type: "updateStatus"; id: string; name?: string; meaning?: StatusMeaning }
  | { type: "reorderStatuses"; folderId: string; orderedIds: string[] }
  | { type: "deleteStatus"; id: string }
  | { type: "createItem"; item: NewItem }
  | { type: "updateItem"; id: string; patch: ItemPatch; fileInbox?: boolean }
  | {
      type: "placeItem";
      id: string;
      folderId: string;
      statusId: string;
      sortOrder: string;
      manual?: true;
    }
  | { type: "deleteItem"; id: string }
  | { type: "restoreItem"; id: string }
  | { type: "purgeItem"; id: string }
  | { type: "purgeFolder"; id: string }
  | { type: "ensureTag"; id: string; name: string; color: FolderPaint | null }
  | { type: "updateTag"; id: string; name?: string; color?: FolderPaint | null }
  | { type: "deleteTag"; id: string }
  | { type: "setItemTags"; itemId: string; tagIds: string[] }
  | {
      type: "createPerson";
      id: string;
      name: string;
      color: FolderPaint | null;
      emoji: string | null;
    }
  | {
      type: "updatePerson";
      id: string;
      name?: string;
      color?: FolderPaint | null;
      emoji?: string | null;
    }
  | { type: "deletePerson"; id: string }
  | { type: "addDependency"; id: string; itemId: string; dependsOnId: string }
  | { type: "removeDependency"; id: string }
  | {
      type: "addLink";
      id: string;
      fromId: string;
      toId: string;
      kind: LinkKind;
    }
  | { type: "removeLink"; id: string }
  | {
      type: "createMilestone";
      id: string;
      folderId: string | null;
      title: string;
      day: string;
    }
  | {
      type: "updateMilestone";
      id: string;
      title?: string;
      day?: string;
      color?: FolderPaint | null;
    }
  | { type: "deleteMilestone"; id: string }
  | {
      type: "createView";
      id: string;
      name: string;
      folderId: string | null;
      query: ViewQuery;
    }
  | { type: "deleteView"; id: string }
  | {
      type: "createRule";
      id: string;
      matchText: string | null;
      matchTagId: string | null;
      actionFolderId: string;
      actionStatusId: string | null;
      actionTagId: string | null;
    }
  | {
      type: "updateRule";
      id: string;
      enabled?: boolean;
      matchText?: string | null;
      matchTagId?: string | null;
      actionFolderId?: string;
      actionStatusId?: string | null;
      actionTagId?: string | null;
    }
  | { type: "deleteRule"; id: string }
  | { type: "reorderRules"; orderedIds: string[] }
  | {
      type: "setRecurrence";
      itemId: string;
      freq: RecurrenceFreq | null;
      interval: number | null;
      weekdays: string | null;
      until: string | null;
    }
  | { type: "sortInbox" }
  | { type: "emptyTrash" }
  | { type: "replaceDb"; db: unknown }
  | { type: "batch"; ops: Op[] };

export type DateRole = "due" | "plan";

export function priorityFromToken(token: string): Priority | null {
  if (token === "nizka" || token === "1") return "low";
  if (token === "vysoka" || token === "3") return "high";
  if (token === "urgentni" || token === "4") return "urgent";
  return null;
}
