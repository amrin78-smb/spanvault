// Shared vendor-key → display-label map.
//
// The collector's SNMP parsers store a lowercase vendor KEY on
// monitored_devices.device_vendor ('paloalto', 'hpe-procurve', …); this turns it
// into something readable. Lives here rather than in a page because both the
// devices list and the device detail page render it — they used to carry
// byte-identical private copies, which is exactly how the two drift apart.
export const VENDOR_LABELS: Record<string, string> = {
  fortinet: 'Fortinet', cisco: 'Cisco', aruba: 'Aruba', paloalto: 'Palo Alto',
  checkpoint: 'Check Point', sonicwall: 'SonicWall', forcepoint: 'Forcepoint',
  sangfor: 'Sangfor', 'hpe-procurve': 'HPE ProCurve', 'hpe-comware': 'HPE Comware',
  juniper: 'Juniper', huawei: 'Huawei', mikrotik: 'MikroTik', ubiquiti: 'Ubiquiti',
  dell: 'Dell', extreme: 'Extreme', brocade: 'Brocade', meraki: 'Cisco Meraki',
  netgear: 'Netgear', tplink: 'TP-Link', generic: 'Generic (standard MIBs)',
};

export function vendorLabel(v: string | null | undefined): string | null {
  if (!v) return null;
  return VENDOR_LABELS[v] || v;
}
