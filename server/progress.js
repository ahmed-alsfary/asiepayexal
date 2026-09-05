/** Shared in-memory import progress for UI polling */
let progress = {
  active: false,
  kind: null,
  stage: 'idle',
  message: '',
  upserted: 0,
  offices: 0,
  activated: 0,
  orphans: 0,
  startedAt: null,
  error: null,
};

function startProgress(kind, message) {
  progress = {
    active: true,
    kind,
    stage: 'start',
    message,
    upserted: 0,
    offices: 0,
    activated: 0,
    orphans: 0,
    startedAt: Date.now(),
    error: null,
  };
}

function updateProgress(partial) {
  progress = {
    ...progress,
    ...partial,
    active: true,
  };
}

function finishProgress(message) {
  progress = {
    ...progress,
    active: false,
    stage: 'done',
    message: message || 'اكتمل',
  };
}

function failProgress(error) {
  progress = {
    ...progress,
    active: false,
    stage: 'error',
    error: error || 'فشل',
    message: error || 'فشل',
  };
}

function getProgress() {
  const elapsedMs = progress.startedAt ? Date.now() - progress.startedAt : 0;
  return {
    ...progress,
    elapsedSec: Math.round(elapsedMs / 1000),
  };
}

module.exports = {
  startProgress,
  updateProgress,
  finishProgress,
  failProgress,
  getProgress,
};
