/**
 * The machine panels: presentational pieces that show a `MachineState`.
 * The stepper page uses them at full size, the MiniStepper with `compact`.
 */
export { CodeListing, type CodeListingProps } from './CodeListing'
export { DataPanel, type DataPanelProps } from './DataPanel'
export { ExplanationPanel, type ExplanationPanelProps } from './ExplanationPanel'
export { FlagsPanel, type FlagsPanelProps } from './FlagsPanel'
export { HexValue, type HexValueProps } from './HexValue'
export { OutputPanel, type OutputPanelProps } from './OutputPanel'
export { PanelBoundary, type PanelBoundaryProps } from './PanelBoundary'
export { RegistersPanel, type RegistersPanelProps } from './RegistersPanel'
export { StackPanel, type StackPanelProps } from './StackPanel'
export {
  callsLibrary,
  instructionText,
  outputChanged,
  registersChanged,
  registersInProgram,
  stackChanged,
} from './machineView'
export * from './words'
