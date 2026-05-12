// Re-export PermissionCoordinator as PermissionManager for backward compatibility
export {
  PermissionCoordinator as PermissionManager,
  type PendingPermission,
  type SandboxPendingPermission,
  type PermissionCoordinatorEmit,
} from './permission/PermissionCoordinator';
