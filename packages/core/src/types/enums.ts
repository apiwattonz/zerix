/**
 * Semantic classification of a context chunk.
 */
export enum ChunkType {
  USER_CONSTRAINT = 'USER_CONSTRAINT',
  DECISION = 'DECISION',
  ERROR_CORRECTION = 'ERROR_CORRECTION',
  FACT = 'FACT',
  TOOL_RESULT = 'TOOL_RESULT',
  REASONING_STEP = 'REASONING_STEP',
  OBSERVATION = 'OBSERVATION'
}

/**
 * Memory hierarchy levels used by Zerix.
 */
export enum MemoryTier {
  L0_REGISTER = 'L0_REGISTER',
  L1_CACHE = 'L1_CACHE',
  L2_RAM = 'L2_RAM',
  L3_SSD = 'L3_SSD',
  L4_ARCHIVE = 'L4_ARCHIVE'
}
