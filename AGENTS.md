# Agent Guidance

### Prompt constraints do not repair provider tool serialization

A smaller, artifact-first prompt can improve completion and recovery, but it cannot make an unstable model/provider serialize native tool calls correctly. Evaluate recon models on two separate axes: whether they produce a usable grounded artifact, and whether their tool protocol remains clean. Recoverable malformed calls still indicate provider risk and should prevent promotion to the default orchestration model.
