export {
  emptyProjection,
  EMPTY_PENDING,
  isProjectionRunActive,
  isProjectionRunEnded,
  mergeThreadProjections,
  projectionToLive,
  projectionToRuns,
  runsToProjectionRuns,
  type ProjectionLive,
  type ProjectionRuns,
  type ThreadProjection,
} from "@features/agent/store/session-reducer/types";
export { reduceProjection } from "@features/agent/store/session-reducer/reduce-projection";