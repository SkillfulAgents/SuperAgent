// kubelet injects KUBERNETES_SERVICE_HOST into every pod. This only means "this
// process runs in a k8s pod", not that the k8s runtime is usable — namespace,
// PVC, and RBAC availability are checked separately via isAvailable().
export function isRunningInKubernetes(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST)
}
