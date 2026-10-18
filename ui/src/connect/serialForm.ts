import type {
  DataBits,
  FlowControl,
  Newline,
  Parity,
  PortInfo,
  SerialOptions,
  StopBits,
} from "@/lib/ipc";

/** Mirrors `BAUD_PRESETS` in crates/proto-serial/src/settings.rs. */
export const BAUD_PRESETS = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800,
] as const;

export interface SerialForm {
  path: string;
  baud: number;
  dataBits: DataBits;
  parity: Parity;
  stopBits: StopBits;
  flowControl: FlowControl;
  transmit: Newline;
  receive: Newline;
  localEcho: boolean;
  vendor: string;
}

/** 9600 8N1, no flow control: the Cisco console default. */
export const EMPTY_SERIAL: SerialForm = {
  path: "",
  baud: 9600,
  dataBits: "eight",
  parity: "none",
  stopBits: "one",
  flowControl: "none",
  transmit: "cr",
  receive: "crlf",
  localEcho: false,
  vendor: "generic",
};

const BITS: Record<DataBits, string> = { five: "5", six: "6", seven: "7", eight: "8" };
const PARITY: Record<Parity, string> = { none: "N", odd: "O", even: "E" };
const STOP: Record<StopBits, string> = { one: "1", two: "2" };

/** "9600 8N1", like `LineSettings::summary`. */
export function lineSummary(f: Pick<SerialForm, "baud" | "dataBits" | "parity" | "stopBits">) {
  return `${f.baud} ${BITS[f.dataBits]}${PARITY[f.parity]}${STOP[f.stopBits]}`;
}

export type SerialErrors = Partial<Record<"path" | "baud", string>>;

export function validateSerial(form: SerialForm): SerialErrors {
  const errors: SerialErrors = {};
  if (!form.path.trim()) errors.path = "Choose a serial port.";
  if (!Number.isInteger(form.baud) || form.baud < 50 || form.baud > 4_000_000)
    errors.baud = "Baud rate must be between 50 and 4,000,000.";
  return errors;
}

/** Short device name for tab titles: `/dev/ttyUSB0` → `ttyUSB0`. */
export function portName(path: string): string {
  return path.split("/").pop() || path;
}

export function buildSerial(form: SerialForm): { options: SerialOptions; title: string } | null {
  if (Object.keys(validateSerial(form)).length > 0) return null;
  return {
    options: {
      path: form.path.trim(),
      settings: {
        baud: form.baud,
        dataBits: form.dataBits,
        parity: form.parity,
        stopBits: form.stopBits,
        flowControl: form.flowControl,
      },
      newline: { transmit: form.transmit, receive: form.receive },
      localEcho: form.localEcho,
    },
    title: `${portName(form.path.trim())} · ${lineSummary(form)}`,
  };
}

/** Keep the chosen port if it is still present, else pick the first USB adapter. */
export function pickPort(current: string, ports: PortInfo[]): string {
  if (current && ports.some((p) => p.path === current)) return current;
  return ports[0]?.path ?? current;
}
