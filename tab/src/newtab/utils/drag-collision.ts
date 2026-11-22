import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core';

// 分组必须实际命中，不能作为“最近目标”误接收鼠标在空白处的放下操作。
export const newtabCollisionDetection: CollisionDetection = (args) => {
  if (args.active.data.current?.type === 'group') {
    const groups = args.droppableContainers.filter((container) => !container.disabled && container.data.current?.type === 'group');
    return args.pointerCoordinates ? pointerWithin({ ...args, droppableContainers: groups }) : closestCenter({ ...args, droppableContainers: groups });
  }
  const candidates = args.droppableContainers.filter((container) =>
    container.id !== args.active.id && !container.disabled && (container.data.current?.type !== 'group' || args.active.data.current?.type === 'shortcut') &&
    (!args.active.data.current?.folderId || container.data.current?.type === 'group' || container.data.current?.folderId === args.active.data.current.folderId)
  );
  const pointerCollisions = pointerWithin({ ...args, droppableContainers: candidates });
  const groupCollision = pointerCollisions.filter((collision) =>
    candidates.some((container) => container.id === collision.id && container.data.current?.type === 'group')
  );
  if (groupCollision.length) return groupCollision;
  if (args.active.data.current?.type === 'shortcut') {
    const folders = pointerCollisions.filter((collision) => candidates.some((container) => container.id === collision.id && container.data.current?.type === 'folder'));
    if (folders.length) return folders;
  }
  if (pointerCollisions.length) return pointerCollisions;
  return closestCenter({ ...args, droppableContainers: candidates.filter((container) => container.data.current?.type !== 'group' && !(args.active.data.current?.type === 'shortcut' && container.data.current?.type === 'folder')) });
};
