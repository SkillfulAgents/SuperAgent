// kubelet injects KUBERNETES_SERVICE_HOST into every pod. This only means "this
// process runs in a k8s pod", not that the k8s runtime is usable — namespace,
// PVC, and RBAC availability are checked separately via isAvailable().
export function isRunningInKubernetes(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST)
}

// Host-app was deployed with the MicroVM agent backend. Settings defaults use
// this; the runtime client still zod-validates the full MICROVM_* config.
export function isMicrovmRuntimeEnvPresent(): boolean {
  const region = process.env.MICROVM_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
  return Boolean(
    region?.trim() &&
    process.env.MICROVM_AGENT_IMAGE_ARN?.trim() &&
    process.env.MICROVM_EXECUTION_ROLE_ARN?.trim() &&
    process.env.MICROVM_EGRESS_CONNECTOR_ARN?.trim(),
  )
}
