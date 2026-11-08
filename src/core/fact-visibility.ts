export const MIN_FACT_CONFIDENCE = 0.7

// Reviewed facts can be shown regardless of their original model score.
export const DISPLAYABLE_FACT = `(f.status IN ('active', 'superseded')
  OR (f.status = 'disputed' AND f.confidence >= ${MIN_FACT_CONFIDENCE}))`

export const ENTITY_HAS_DISPLAYABLE_FACT = `EXISTS (
  SELECT 1 FROM facts f WHERE f.tenant_id = e.tenant_id
    AND (f.subject_id = e.id OR f.object_id = e.id) AND ${DISPLAYABLE_FACT}
)`
