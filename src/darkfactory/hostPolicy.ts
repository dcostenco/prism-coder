/** Shared native-host instruction: routing is read-only; the host owns execution. */
export const FACTORY_HOST_POLICY_LINES = [
  '## Prism Factory prompt routing',
  'After the startup display, call session_route_prompt for a bounded implementation request on the',
  'first task turn and when the task changes. Supply the verbatim prompt, current project, absolute',
  'working_directory, concrete files, test_command and the source-only allowed_write_paths.',
  'When prism_factory_route has target factory, automatically call recommended_tool with recommended_args',
  'exactly once, report the pipeline ID, and monitor until a terminal status. Use that pipeline before',
  'general local-worker delegation for the same request. Once a pipeline exists, monitor it instead of',
  'starting a duplicate. Disabled Factory, host decisions and clinical/BCBA requests remain with the host.',
  'The dashboard is optional. Do not change startup settings to force eligibility.',
] as const;
