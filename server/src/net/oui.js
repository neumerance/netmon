// MAC prefix (OUI, first 3 octets) -> vendor organisation name. PLAN.md §2.2.
//
// A curated, offline subset of the IEEE MA-L registry focused on devices commonly found on home and
// small-office networks. Vendor strings follow the IEEE organisation names so that
// net/fingerprint/vendorHints.js can match them with case-insensitive regexes (/apple/i, /sonos/i,
// /tp-?link/i, ...). Randomized (locally administered) MACs carry no vendor and always return null.
//
// Coverage is deliberately "precision over recall": an unknown prefix yields null (the fingerprinter
// then relies on mDNS / SSDP / ports / hostname instead), which is better than a wrong vendor.

import { normalizeMac, isRandomizedMac, isMulticastOrBroadcastMac } from './sys.js';

// vendor -> whitespace-separated prefixes (lowercase, colon form)
const VENDORS = {
  // ---------------------------------------------------------------- phones / computers / tablets
  'Apple, Inc.': `
    00:03:93 00:05:02 00:0a:27 00:0a:95 00:0d:93 00:10:fa 00:11:24 00:14:51 00:16:cb 00:17:f2 00:19:e3 00:1b:63
    00:1c:b3 00:1d:4f 00:1e:52 00:1e:c2 00:1f:5b 00:1f:f3 00:21:e9 00:22:41 00:23:12 00:23:32 00:23:6c 00:23:df
    00:24:36 00:25:00 00:25:4b 00:25:bc 00:26:08 00:26:4a 00:26:b0 00:26:bb 00:3e:e1 00:50:e4 00:c6:10 00:f4:b9
    04:0c:ce 04:15:52 04:1e:64 04:26:65 04:48:9a 04:4b:ed 04:52:f3 04:54:53 04:69:f8 04:d3:cf 04:db:56 04:e5:36
    04:f1:3e 04:f7:e4 08:00:07 08:66:98 08:6d:41 08:70:45 08:74:02 0c:15:39 0c:30:21 0c:3e:9f 0c:4d:e9 0c:51:01
    0c:74:c2 0c:77:1a 10:1c:0c 10:40:f3 10:41:7f 10:93:e9 10:9a:dd 10:dd:b1 14:10:9f 14:20:5e 14:5a:05 14:8f:c6
    14:99:e2 18:20:32 18:34:51 18:65:90 18:81:0e 18:9e:fc 18:af:61 18:af:8f 18:e7:f4 18:ee:69 18:f6:43 1c:1a:c0
    1c:36:bb 1c:5c:f2 1c:91:48 1c:9e:46 1c:ab:a7 1c:e6:2b 20:3c:ae 20:76:8f 20:78:f0 20:7d:74 20:9b:cd 20:a2:e4
    20:ab:37 20:c9:d0 24:1e:eb 24:24:0e 24:a0:74 24:a2:e1 24:ab:81 24:e3:14 24:f0:94 24:f6:77 28:0b:5c 28:37:37
    28:5a:eb 28:6a:b8 28:6a:ba 28:a0:2b 28:cf:da 28:cf:e9 28:e0:2c 28:e1:4c 28:e7:cf 28:f0:76 2c:1f:23 2c:20:0b
    2c:33:61 2c:b4:3a 2c:be:08 2c:f0:a2 2c:f0:ee 30:10:e4 30:35:ad 30:63:6b 30:90:ab 30:f7:c5 34:08:bc 34:12:98
    34:15:9e 34:36:3b 34:51:c9 34:a3:95 34:c0:59 34:e2:fd 38:0f:4a 38:48:4c 38:53:9c 38:66:f0 38:71:de 38:89:2c
    38:b5:4d 38:c9:86 38:ca:da 3c:06:30 3c:07:54 3c:15:c2 3c:2e:f9 3c:2e:ff 3c:ab:8e 3c:d0:f8 3c:e0:72 40:30:04
    40:33:1a 40:3c:fc 40:4d:7f 40:6c:8f 40:83:1d 40:98:ad 40:9c:28 40:a6:d9 40:b3:95 40:bc:60 40:cb:c0 40:d3:2d
    44:00:10 44:2a:60 44:4c:0c 44:4a:db 44:d8:84 44:fb:42 48:3b:38 48:43:7c 48:4b:aa 48:60:bc 48:74:6e 48:a1:95
    48:a9:1c 48:bf:6b 48:d7:05 48:e9:f1 4c:32:75 4c:57:ca 4c:74:bf 4c:7c:5f 4c:8d:79 4c:b1:99 4c:b9:10 50:32:37
    50:7a:55 50:82:d5 50:bc:96 50:de:06 50:ea:d6 54:26:96 54:33:cb 54:4e:90 54:72:4f 54:9f:13 54:ae:27 54:e4:3a
    54:e6:1b 54:ea:a8 58:1f:aa 58:40:4e 58:55:ca 58:7f:57 58:b0:35 58:e2:8f 5c:09:47 5c:1d:d9 5c:59:48 5c:8d:4e
    5c:95:ae 5c:96:9d 5c:97:f3 5c:ad:cf 5c:f5:da 5c:f7:e6 5c:f9:38 60:03:08 60:30:d4 60:33:4b 60:69:44 60:83:73
    60:8c:4a 60:92:17 60:9a:c1 60:a3:7d 60:c5:47 60:d9:c7 60:f4:45 60:f8:1d 60:fa:cd 60:fb:42 60:fe:c5 64:20:0c
    64:4b:f0 64:5a:ed 64:70:33 64:76:ba 64:9a:be 64:a3:cb 64:a5:c3 64:b0:a6 64:b9:e8 64:e6:82 68:09:27 68:5b:35
    68:64:4b 68:96:7b 68:9c:70 68:a8:6d 68:ab:1e 68:ae:20 68:d9:3c 68:db:ca 68:fb:7e 68:fe:f7 6c:19:c0 6c:3e:6d
    6c:40:08 6c:4a:85 6c:4d:73 6c:70:9f 6c:72:e7 6c:8d:c1 6c:94:f8 6c:96:cf 6c:ab:31 6c:c2:6b 6c:e8:5c 70:11:24
    70:14:a6 70:3e:ac 70:48:0f 70:56:81 70:73:cb 70:81:eb 70:a2:b3 70:cd:60 70:de:e2 70:e7:2c 70:ea:5a 70:ec:e4
    70:f0:87 74:1b:b2 74:42:8b 74:81:14 74:8d:08 74:8f:3c 74:9e:af 74:a6:cd 74:b5:87 74:e1:b6 74:e2:f5 78:31:c1
    78:3a:84 78:4f:43 78:64:c0 78:67:d7 78:6c:1c 78:7b:8a 78:7e:61 78:88:6d 78:9f:70 78:a3:e4 78:ca:39 78:d7:5f
    78:e3:de 78:fd:94 7c:01:91 7c:04:d0 7c:11:be 7c:50:49 7c:6d:62 7c:6d:f8 7c:9a:1d 7c:a1:ae 7c:ab:60 7c:c3:a1
    7c:c5:37 7c:d1:c3 7c:f0:5f 7c:fa:df 80:00:6e 80:0c:67 80:49:71 80:82:23 80:92:9f 80:a9:97 80:b0:3d 80:be:05
    80:d6:05 80:e6:50 80:ea:96 80:ed:2c 84:29:99 84:38:35 84:41:67 84:68:3e 84:78:8b 84:85:06 84:89:ad 84:8e:0c
    84:a1:34 84:ab:1a 84:b1:53 84:fc:ac 84:fc:fe 88:1f:a1 88:53:95 88:63:df 88:64:40 88:66:a5 88:6b:6e 88:a4:79
    88:ae:07 88:b2:91 88:c0:8b 88:c6:63 88:cb:87 88:e8:7f 88:e9:fe 8c:00:6d 8c:29:37 8c:2d:aa 8c:58:77 8c:7a:aa
    8c:7b:9d 8c:7c:92 8c:85:90 8c:86:1e 8c:8e:f2 8c:8f:e9 8c:fa:ba 90:27:e4 90:3c:92 90:60:f1 90:72:40 90:81:2a
    90:84:0d 90:8d:6c 90:9c:4a 90:a2:5b 90:b0:ed 90:b2:1f 90:b9:31 90:c1:c6 90:dd:5d 90:e1:7b 90:fd:61 94:94:26
    94:bf:2d 94:e9:6a 94:f6:a3 94:f6:d6 98:00:c6 98:01:a7 98:03:d8 98:10:e8 98:46:0a 98:5a:eb 98:9e:63 98:b8:e3
    98:ca:33 98:d6:bb 98:dd:60 98:e0:d9 98:f0:ab 98:fe:94 9c:04:eb 9c:20:7b 9c:29:3f 9c:35:eb 9c:4f:da 9c:58:84
    9c:64:8b 9c:84:bf 9c:8b:a0 9c:e3:3f 9c:e6:5e 9c:f3:87 9c:f4:8e 9c:fc:01 a0:18:28 a0:3b:e3 a0:4e:a7 a0:4e:cf
    a0:56:f3 a0:78:17 a0:99:9b a0:a3:09 a0:d7:95 a0:ed:cd a4:31:35 a4:5e:60 a4:67:06 a4:83:e7 a4:b1:97 a4:b8:05
    a4:c3:37 a4:c3:61 a4:cf:99 a4:d1:8c a4:d1:d2 a4:d9:31 a4:e9:75 a4:f1:e8 a8:20:66 a8:4a:28 a8:51:ab a8:5b:78
    a8:5c:2c a8:60:b6 a8:66:7f a8:81:7e a8:86:dd a8:88:08 a8:8e:24 a8:8f:d9 a8:91:3d a8:96:8a a8:bb:cf a8:be:27
    a8:fa:d8 a8:fe:9d ac:00:7a ac:15:f4 ac:1d:06 ac:1f:74 ac:29:3a ac:3c:0b ac:49:db ac:61:ea ac:7f:3e ac:87:a3
    ac:88:fd ac:90:85 ac:bc:32 ac:c9:06 ac:cf:5c ac:e4:b5 ac:fd:ec b0:19:c6 b0:34:95 b0:48:1a b0:65:bd b0:67:2f
    b0:70:2d b0:8c:75 b0:9f:ba b0:be:83 b0:ca:68 b0:e5:f9 b4:0b:44 b4:18:d1 b4:1b:b0 b4:4b:d2 b4:8b:19 b4:9c:df
    b4:f0:ab b4:f6:1c b4:fa:48 b8:09:8a b8:17:c2 b8:41:a4 b8:44:d9 b8:4f:d5 b8:53:ac b8:5d:0a b8:63:4d b8:78:2e
    b8:7b:c5 b8:81:fa b8:8d:12 b8:90:47 b8:9a:2a b8:c1:11 b8:c7:5d b8:e6:0c b8:e8:56 b8:f1:2a b8:f6:b1 b8:ff:61
    bc:09:1b bc:3b:af bc:4c:c4 bc:52:b7 bc:54:36 bc:67:78 bc:6c:21 bc:92:6b bc:9f:ef bc:a5:a9 bc:a9:20 bc:b8:63
    bc:d0:74 bc:e1:43 bc:ec:5d c0:1a:da c0:63:94 c0:84:7a c0:95:6d c0:9a:d0 c0:9f:42 c0:a5:3e c0:b6:58 c0:cc:f8
    c0:ce:cd c0:d0:12 c0:e8:62 c0:f2:fb c4:2c:03 c4:35:d9 c4:61:8b c4:84:66 c4:b3:01 c4:c3:6b c8:1e:e7 c8:2a:14
    c8:33:4b c8:3c:85 c8:4c:75 c8:69:cd c8:6f:1d c8:85:50 c8:89:f3 c8:b1:cd c8:b5:b7 c8:bc:c8 c8:d0:83 c8:e0:eb
    c8:f6:50 cc:08:8d cc:08:e0 cc:20:e8 cc:25:ef cc:29:f5 cc:2d:b7 cc:44:63 cc:4b:73 cc:66:0a cc:69:fa cc:78:5f
    cc:81:7d cc:c7:60 cc:d2:81 d0:03:4b d0:11:e5 d0:23:db d0:25:98 d0:33:11 d0:4f:7e d0:81:7a d0:88:0c d0:a6:37
    d0:c5:f3 d0:d2:3c d0:d2:b0 d0:e1:40 d4:1a:3f d4:61:9d d4:68:aa d4:90:9c d4:9a:20 d4:a3:3d d4:dc:cd d4:f4:6f
    d8:00:4d d8:1c:79 d8:1d:72 d8:30:62 d8:4c:90 d8:8f:76 d8:96:95 d8:9e:3f d8:a2:5e d8:bb:2c d8:be:1f d8:cf:9c
    d8:d1:cb d8:dc:40 d8:de:3a dc:08:0f dc:0c:5c dc:2b:2a dc:2b:61 dc:37:14 dc:41:5f dc:52:85 dc:53:92 dc:56:e7
    dc:80:84 dc:86:d8 dc:9b:9c dc:a4:ca dc:a9:04 dc:b5:4f dc:d3:a2 e0:2b:96 e0:33:8e e0:5f:45 e0:66:78 e0:6d:17
    e0:89:7e e0:ac:cb e0:b5:2d e0:b9:ba e0:bd:a0 e0:c3:ea e0:c7:67 e0:c9:7a e0:eb:40 e0:f5:c6 e0:f8:47 e4:25:e7
    e4:2b:34 e4:50:eb e4:76:84 e4:8b:7f e4:90:fd e4:98:d6 e4:9a:79 e4:9a:dc e4:b2:fb e4:c6:3d e4:ce:8f e4:e0:a6
    e4:e4:ab e8:04:0b e8:06:88 e8:1c:d8 e8:36:17 e8:78:65 e8:7f:95 e8:80:2e e8:81:52 e8:85:4b e8:8d:28 e8:b2:ac
    ec:0d:51 ec:26:51 ec:28:d3 ec:2c:e2 ec:35:86 ec:42:cc ec:46:84 ec:73:79 ec:81:50 ec:85:2f ec:a9:07 ec:ce:d7
    f0:18:98 f0:24:75 f0:2f:4b f0:5c:d5 f0:76:6f f0:79:60 f0:98:9d f0:99:b6 f0:99:bf f0:a3:5a f0:b0:e7 f0:b3:ec
    f0:b4:79 f0:c1:f1 f0:c3:71 f0:cb:a1 f0:d1:a9 f0:d3:1f f0:d7:93 f0:db:e2 f0:db:f8 f0:dc:e2 f0:ee:7a f0:f6:1c
    f4:06:16 f4:0e:01 f4:0f:24 f4:1b:a1 f4:21:ca f4:31:c3 f4:34:f0 f4:37:b7 f4:5c:89 f4:65:a6 f4:81:c4 f4:af:e7
    f4:be:ec f4:d4:88 f4:dc:f9 f4:e8:c7 f4:f1:5a f4:f9:51 f8:03:77 f8:10:93 f8:1e:df f8:27:93 f8:2d:7c f8:38:80
    f8:4d:89 f8:4e:73 f8:62:14 f8:66:5a f8:6f:c1 f8:73:df f8:87:f1 f8:95:ea f8:b1:dd f8:c3:cc f8:e5:ce f8:e9:4e
    f8:f5:8c f8:ff:c2 fc:18:3c fc:1d:43 fc:25:3f fc:2a:9c fc:47:d8 fc:4e:a4 fc:5c:ee fc:66:cf fc:aa:81 fc:b6:d8
    fc:d8:48 fc:e2:6c fc:e9:98 fc:fc:48`,
  'Samsung Electronics Co.,Ltd': `
    00:00:f0 00:02:78 00:07:ab 00:12:47 00:12:fb 00:13:77 00:15:99 00:15:b9 00:16:32 00:16:6b 00:16:6c 00:16:db
    00:17:c9 00:17:d5 00:18:af 00:1a:8a 00:1b:98 00:1c:43 00:1d:25 00:1d:f6 00:1e:7d 00:1e:e1 00:1e:e2 00:1f:cc
    00:1f:cd 00:21:19 00:21:4c 00:21:d1 00:21:d2 00:23:39 00:23:3a 00:23:99 00:23:d6 00:23:d7 00:24:54 00:24:90
    00:24:91 00:24:e9 00:25:66 00:25:67 00:26:37 00:26:5d 00:26:5f 04:18:0f 04:1b:ba 04:fe:31 08:08:c2 08:37:3d
    08:d4:2b 08:ec:a9 08:fc:88 0c:14:20 0c:71:5d 0c:89:10 0c:df:a4 10:1d:c0 10:30:47 10:d5:42 14:49:e0 14:89:fd
    14:bb:6e 18:3a:2d 18:3f:47 18:67:b0 18:e2:c2 1c:5a:3e 1c:62:b8 1c:66:aa 20:13:e0 20:64:32 20:d3:90 24:4b:81
    24:92:0e 24:c6:96 24:db:ed 28:98:7b 28:ba:b5 28:cc:01 2c:ae:2b 30:19:66 30:96:fb 30:cd:a7 34:23:ba 34:be:00
    38:01:97 38:0a:94 38:16:d1 38:2d:d1 3c:5a:37 3c:62:00 3c:8b:fe 40:0e:85 44:4e:1a 44:78:3e 4c:3c:16 50:01:bb
    50:32:75 50:a4:c8 50:b7:c3 50:cc:f8 50:f5:20 54:88:0e 54:92:be 58:c3:8b 5c:0a:5b 5c:3c:27 5c:e8:eb 60:6b:bd
    60:a1:0a 64:1c:ae 64:b3:10 68:eb:ae 6c:2f:2c 6c:83:36 70:f9:27 74:45:8a 78:1f:db 78:25:ad 78:47:1d 78:52:1a
    78:9e:d0 78:ab:bb 78:bd:bc 7c:0b:c6 7c:1c:68 80:18:a7 84:25:db 84:38:38 84:55:a5 88:32:9b 88:9b:39 8c:71:f8
    8c:77:12 8c:79:f5 90:18:7c 94:35:0a 94:63:d1 98:52:b1 9c:02:98 9c:3a:af a0:07:98 a0:0b:ba a0:82:1f a4:eb:d3
    a8:06:00 a8:7c:01 ac:36:13 ac:5f:3e b0:47:bf b0:72:bf b4:79:a7 b8:5e:7b bc:14:85 bc:20:a4 bc:44:86 bc:72:b1
    c0:97:27 c4:42:02 c4:57:6e c8:14:79 c8:19:f7 cc:07:ab cc:3a:61 d0:22:be d0:59:e4 d0:66:7b d4:87:d8 d8:57:ef
    d8:90:e8 dc:71:44 e4:12:1d e4:40:e2 e4:7c:f9 e4:e0:c5 e8:03:9a e8:4e:84 ec:1f:72 f0:25:b7 f0:5a:09 f4:7b:5e
    f4:9f:54 f8:04:2e f8:d0:bd fc:a1:3e fc:c7:34`,
  'Google, Inc.': `
    00:1a:11 08:9e:08 1c:f2:9a 20:df:b9 30:fd:38 3c:28:6d 3c:5a:b4 44:07:0b 48:d6:d5 54:60:09 58:cb:52 6c:ad:f8
    70:3a:cb 7c:2e:bd 88:3d:24 94:eb:2c a4:77:33 d8:6c:63 e4:f0:42 f4:f5:d8 f4:f5:e8 f8:0f:f9 f8:8f:ca 00:f6:20
    14:c1:4e 1c:53:f9 24:05:88 38:8b:59 3c:8d:20 ac:67:84 cc:f4:11 d4:f5:47`,
  'Nest Labs Inc.': '18:b4:30 64:16:66',
  'Amazon Technologies Inc.': `
    00:71:47 00:fc:8b 08:84:9d 08:a6:bc 0c:47:c9 0c:ee:99 10:ae:60 18:74:2e 1c:12:b0 24:4c:e3 34:d2:70 38:f7:3d
    40:a2:db 40:b4:cd 44:00:49 44:65:0d 4c:ef:c0 50:dc:e7 50:f5:da 5c:41:5a 68:37:e9 68:54:fd 6c:56:97 74:58:f3
    74:75:48 74:c2:46 78:e1:03 84:d6:d0 88:71:e5 90:a8:22 a0:02:dc a4:08:01 ac:63:be b0:fc:0d b4:7c:9c cc:9e:a2
    f0:27:2d f0:81:73 f0:d2:f1 fc:65:de fc:a1:83`,
  'Microsoft Corporation': `
    00:03:ff 00:0d:3a 00:12:5a 00:15:5d 00:17:fa 00:1d:d8 00:22:48 00:25:ae 00:50:f2 28:18:78 30:59:b7 38:56:3d
    50:1a:c5 58:82:a8 5c:ba:37 60:45:bd 7c:1e:52 7c:ed:8d 98:5f:d3 bc:83:85 c4:9d:ed c8:3f:26 dc:b4:c4 f0:6e:0b`,
  'Huawei Technologies Co.,Ltd': `
    00:18:82 00:1e:10 00:25:68 00:25:9e 00:46:4b 00:66:4b 00:9a:cd 00:e0:fc 04:02:1f 04:bd:70 04:c0:6f 04:f9:38
    08:19:a6 08:63:61 08:7a:4c 0c:37:dc 0c:96:bf 10:1b:54 10:47:80 10:c6:1f 14:b9:68 18:c5:8a 1c:8e:5c 20:08:ed
    20:0b:c7 20:f3:a3 24:09:95 24:69:a5 24:db:ac 28:31:52 28:3c:e4 28:6e:d4 30:87:30 34:00:a3 34:6b:d3 38:bc:01
    3c:47:11 40:4d:8e 48:46:fb 48:62:76 4c:1f:cc 4c:54:99 4c:8b:ef 50:9f:27 54:89:98 58:1f:28 5c:7d:5e 60:de:44
    64:16:f0 70:72:3c 70:7b:e8 74:88:2a 78:1d:ba 78:d7:52 7c:60:97 80:38:bc 80:b6:86 80:fb:06 84:a8:e4 88:53:d4
    88:e3:ab 8c:34:fd 90:17:ac 94:04:9c 9c:28:ef a4:99:47 ac:85:3d ac:e2:15 b4:15:13 bc:76:70 c4:07:2f c8:d1:5e
    cc:96:a0 d0:7a:b5 d4:6a:a8 d8:49:0b dc:d2:fc e0:24:7f e4:68:a3 e8:cd:2d ec:23:3d f4:55:9c f8:4a:bf fc:48:ef`,
  'Xiaomi Communications Co Ltd': `
    00:9e:c8 0c:1d:af 10:2a:b3 14:f6:5a 18:59:36 20:82:c0 28:6c:07 28:e3:1f 34:80:b3 34:ce:00 38:a4:ed 3c:bd:3e
    4c:49:e3 50:64:2b 58:44:98 64:09:80 64:b4:73 64:cc:2e 68:df:dd 74:23:44 74:51:ba 78:02:f8 7c:1d:d9 8c:be:be
    98:fa:e3 9c:99:a0 a0:86:c6 ac:c1:ee ac:f7:f3 b0:e2:35 c4:0b:cb c4:6a:b7 d4:97:0b f0:b4:29 f4:8b:32 f8:a4:5f
    fc:64:ba`,
  'OnePlus Technology (Shenzhen) Co., Ltd': '94:65:2d c0:ee:fb 64:a2:f9',
  'Motorola Mobility LLC, a Lenovo Company': `
    34:bb:26 40:78:6a 44:80:eb 5c:51:88 60:be:b5 68:c4:4d 80:6c:1b 84:10:0d 90:68:c3 9c:d9:17 cc:c3:ea e0:98:61
    e8:91:20 f0:d7:aa f8:cf:c5 f8:f1:b6`,
  'zte corporation': `
    00:15:eb 00:19:c6 00:1e:73 00:22:93 00:25:12 00:26:ed 08:18:1a 0c:12:62 14:60:80 2c:26:c5 34:4b:50 4c:09:b4
    54:22:f8 68:1a:b2 6c:8b:2f 78:31:2b 90:1d:27 98:6c:f5 9c:d2:4b b0:75:d5 c8:64:c7 d0:15:4a e0:c3:f3 f4:6d:e2
    fc:c8:97`,
  'LG Electronics': `
    00:1c:62 00:1e:75 00:1f:6b 00:1f:e3 00:22:a9 00:24:83 00:25:e5 00:26:e2 00:aa:70 00:e0:91 10:68:3f 10:f9:6f
    14:c9:13 20:21:a5 2c:54:cf 30:76:6f 34:4d:f7 38:8c:50 3c:bd:d8 40:b0:fa 58:a2:b5 58:fd:b1 5c:70:a3 64:89:9a
    64:99:5d 64:bc:0c 6c:d6:8a 74:40:be 78:5d:c8 7c:1c:4e 88:c9:d0 8c:3a:e3 a8:16:b2 a8:23:fe ac:0d:1b b4:0e:de
    b8:16:5f bc:f5:ac c4:36:6c c4:9a:02 c8:08:e9 cc:2d:8c e8:5b:5b f8:0c:f3`,
  'Sony Corporation': `
    00:01:4a 00:13:a9 00:1a:80 00:1d:ba 00:24:be 04:5d:4b 10:4f:a8 30:52:cb 3c:01:ef 54:42:49 58:48:22 78:84:3c
    ac:9b:0a d8:d4:3c f0:bf:97 fc:f1:52`,

  // ---------------------------------------------------------------- PC hardware / NICs
  'Intel Corporate': `
    00:02:b3 00:03:47 00:04:23 00:07:e9 00:0c:f1 00:0e:0c 00:0e:35 00:11:11 00:12:f0 00:13:02 00:13:20 00:13:ce
    00:13:e8 00:15:00 00:15:17 00:16:6f 00:16:76 00:16:ea 00:16:eb 00:18:de 00:19:d1 00:19:d2 00:1b:21 00:1b:77
    00:1c:bf 00:1c:c0 00:1d:e0 00:1d:e1 00:1e:64 00:1e:65 00:1e:67 00:1f:3b 00:1f:3c 00:20:7b 00:21:5c 00:21:5d
    00:21:6a 00:21:6b 00:22:fa 00:22:fb 00:23:14 00:23:15 00:24:d6 00:24:d7 00:26:c6 00:26:c7 00:27:10 08:11:96
    0c:8b:fd 0c:d2:92 10:02:b5 10:0b:a9 18:3d:a2 18:56:80 18:5e:0f 1c:69:7a 24:77:03 28:16:ad 30:3a:64 34:02:86
    34:13:e8 34:de:1a 34:e6:ad 3c:a9:f4 3c:f8:62 40:25:c2 44:85:00 48:51:b7 4c:34:88 4c:79:6e 4c:eb:42 50:76:af
    58:91:cf 5c:51:4f 5c:c5:d4 5c:e0:c5 60:36:dd 60:57:18 60:67:20 64:80:99 68:05:ca 68:17:29 6c:88:14 70:1c:e7
    74:e5:f9 78:0c:b8 78:92:9c 7c:5c:f8 7c:7a:91 80:00:0b 80:19:34 80:86:f2 84:3a:4b 84:a6:c8 88:53:2e 8c:70:5a
    90:2e:1c 90:61:ae 94:65:9c 98:2c:bc 98:4f:ee 9c:4e:36 a0:36:9f a0:88:b4 a0:a8:cd a4:34:d9 a4:4e:31 a8:6d:aa
    ac:72:89 ac:7b:a1 ac:ed:5c b4:6b:fc b4:96:91 b8:08:cf b8:81:98 bc:77:37 c4:85:08 c8:f7:33 cc:3d:82 d0:7e:35
    d4:3b:04 d8:fc:93 dc:53:60 e0:94:67 e4:02:9b e4:a7:a0 e8:2a:ea e8:b1:fc f0:77:c3 f4:06:69 f4:8c:50 f8:16:54
    f8:63:3f f8:94:c2 fc:f8:ae`,
  'Realtek Semiconductor Corp.': '00:e0:4c',
  'Dell Inc.': `
    00:06:5b 00:08:74 00:0b:db 00:0d:56 00:0f:1f 00:11:43 00:12:3f 00:13:72 00:14:22 00:15:c5 00:16:f0 00:18:8b
    00:19:b9 00:1a:a0 00:1c:23 00:1d:09 00:1e:4f 00:1e:c9 00:21:70 00:21:9b 00:22:19 00:23:ae 00:24:e8 00:25:64
    00:26:b9 14:18:77 14:fe:b5 18:03:73 18:66:da 18:a9:9b 18:db:f2 1c:40:24 20:47:47 24:6e:96 24:b6:fd 28:f1:0e
    34:17:eb 34:48:ed 34:e6:d7 44:a8:42 4c:76:25 50:9a:4c 54:9f:35 5c:26:0a 5c:f9:dd 64:00:6a 6c:2b:59 74:86:7a
    74:e6:e2 78:2b:cb 78:45:c4 80:18:44 84:2b:2b 84:7b:eb 84:8f:69 8c:ec:4b 90:b1:1c 98:90:96 98:e7:43 a4:1f:72
    a4:bb:6d a4:ba:db b0:83:fe b4:e1:0f b8:2a:72 b8:ac:6f b8:ca:3a bc:30:5b c8:1f:66 c8:4b:d6 d0:67:e5 d4:81:d7
    d4:ae:52 d4:be:d9 e0:db:55 e4:43:4b e4:b9:7a ec:f4:bb f0:1f:af f0:4d:a2 f4:8e:38 f8:b1:56 f8:bc:12 f8:db:88`,
  'Hewlett Packard': `
    00:01:e6 00:02:a5 00:0b:cd 00:0f:20 00:10:83 00:11:0a 00:11:85 00:12:79 00:13:21 00:14:38 00:14:c2 00:15:60
    00:16:35 00:17:08 00:17:a4 00:18:fe 00:19:bb 00:1a:4b 00:1b:78 00:1c:c4 00:1e:0b 00:1f:29 00:21:5a 00:22:64
    00:23:7d 00:24:81 00:25:b3 00:26:55 10:1f:74 2c:41:38 2c:44:fd 30:8d:99 38:ea:a7 3c:d9:2b 40:b0:34 6c:3b:e5
    70:10:6f 78:e3:b5 80:c1:6e 94:57:a5 98:4b:e1 a0:48:1c b4:99:ba d4:c9:ef ec:b1:d7 f0:92:1c`,
  'HP Inc.': `
    10:e7:c6 3c:52:82 64:51:06 6c:02:e0 70:5a:0f 7c:4d:8f 80:ce:62 84:69:93 9c:7b:ef a0:8c:fd a0:d3:c1 b0:5c:da
    c8:d3:ff e8:d8:d1 f4:39:09 f8:0d:ac fc:3f:db`,
  'LCFC(HeFei) Electronics Technology co., ltd': '8c:16:45 98:fa:9b e8:6a:64',
  'Micro-Star INTL CO., LTD.': '00:16:17 00:19:db 00:21:85 00:24:21 00:d8:61 04:7c:16 2c:f0:5d 30:9c:23 44:8a:5b 4c:cc:6a d4:3d:7e d8:bb:c1',
  'GIGA-BYTE TECHNOLOGY CO.,LTD.': '00:0d:61 00:0f:ea 00:16:e6 00:1a:4d 00:1d:7d 00:1f:d0 00:20:ed 00:24:1d 18:c0:4d 1c:1b:0d 1c:6f:65 40:8d:5c 50:e5:49 74:56:3c 74:d4:35 94:de:80 b4:2e:99 e0:d5:5e fc:aa:14',
  'ASRock Incorporation': '00:25:22 70:85:c2 a8:a1:59 bc:5f:f4',
  'Hon Hai Precision Ind. Co.,Ltd.': `
    00:01:6c 00:16:cf 00:19:7d 00:1c:26 00:1d:d9 00:1e:4c 00:1f:e1 00:22:68 00:23:4d 00:24:2c 00:26:5e 08:3e:8e
    0c:ee:e6 1c:3e:84 20:16:d8 28:e3:47 3c:77:e6 44:6d:57 4c:0f:6e 54:35:30 5c:ac:4c 64:27:37 68:94:23 70:18:8b
    74:e5:43 80:56:f2 84:4b:f5 88:9f:fa 90:00:4e 90:48:9a 94:39:e5 ac:b5:7d c0:18:85 c0:38:96 d0:27:88 d0:df:9a
    e0:06:e6 e4:d5:3d f0:7b:cb f4:b7:e2`,
  'AzureWave Technology Inc.': '00:15:af 1c:4b:d6 28:c2:dd 48:5d:60 54:27:1e 64:6e:69 6c:71:d9 74:c6:3b 80:a5:89 94:db:c9 ac:89:95 b0:ee:45 d0:c5:d3 dc:85:de e0:b9:a5 f0:03:8c',
  'Liteon Technology Corporation': '1c:65:9d 20:68:9d 30:10:b3 40:f0:2f 58:00:e3 70:f1:a1 74:de:2b 94:53:30 9c:b7:0d a4:db:30 c0:cb:38 d0:53:49',
  'Murata Manufacturing Co., Ltd.': '00:0e:6d 00:13:e0 00:21:e8 00:26:e8 00:37:6d 00:60:57 14:7d:c5 1c:99:4c 20:02:af 40:f3:08 44:a7:cf 5c:f8:a1 60:21:c0 78:4b:87 88:30:8a 90:b6:86 98:f1:70 a0:cc:2b f0:27:65 fc:c2:de',
  'Raspberry Pi Foundation': 'b8:27:eb',
  'Raspberry Pi Trading Ltd': 'dc:a6:32 e4:5f:01 d8:3a:dd 28:cd:c1 2c:cf:67',
  'VMware, Inc.': '00:05:69 00:0c:29 00:1c:14 00:50:56',
  'Parallels, Inc.': '00:1c:42',
  'PCS Computer Systems GmbH': '08:00:27',
  'Xensource, Inc.': '00:16:3e',
  'NVIDIA': '00:04:4b 48:b0:2d',

  // ---------------------------------------------------------------- routers / access points / network gear
  'Ubiquiti Inc.': `
    00:15:6d 00:27:22 04:18:d6 0c:ea:14 18:e8:29 1c:6a:1b 24:5a:4c 24:a4:3c 28:70:4e 44:d9:e7 58:d6:1f 60:22:32
    68:72:51 68:d7:9a 6c:63:f8 70:a7:41 74:83:c2 74:ac:b9 78:45:58 78:8a:20 80:2a:a8 94:2a:6f 9c:05:d6 ac:8b:a9
    b4:fb:e4 d0:21:f9 d8:b3:70 dc:9f:db e0:63:da e4:38:83 f0:9f:c2 f4:92:bf fc:ec:da`,
  'eero inc.': `
    18:90:88 20:be:cd 30:57:8e 3c:5c:f1 44:ac:85 50:27:a9 5c:a5:bc 60:57:7d 64:97:14 64:c2:69 68:4a:76 70:93:c1
    74:b6:b6 78:76:89 80:da:13 84:70:d7 98:ed:7e 9c:0b:05 ac:ec:85 b4:20:46 c0:36:53 c4:f1:74 d4:05:de e8:d3:eb
    f0:21:e0 f8:bb:bf`,
  'TP-LINK TECHNOLOGIES CO.,LTD.': `
    00:1d:0f 00:23:cd 00:27:19 10:fe:ed 14:cc:20 14:cf:92 18:a6:f7 1c:3b:f3 1c:61:b4 28:87:ba 30:b5:c2 3c:84:6a
    40:16:9f 48:22:54 50:3e:aa 50:c7:bf 54:c8:0f 5c:62:8b 5c:a6:e6 60:e3:27 64:66:b3 64:70:02 68:ff:7b 6c:5a:b0
    70:4f:57 74:da:88 78:20:51 84:16:f9 90:9a:4a 98:25:4a 98:da:c4 98:de:d0 a0:f3:c1 a4:2b:b0 a8:42:a1 ac:84:c6
    b0:4e:26 b0:95:75 b0:a7:b9 b4:b0:24 c0:06:c3 c0:25:e9 c0:4a:00 c4:6e:1f cc:32:e5 d4:6e:0e d8:07:b6 d8:47:32
    e4:c3:2a e8:48:b8 e8:94:f6 ec:08:6b ec:17:2f f4:ec:38 f4:f2:6d f8:1a:67`,
  'TP-Link Corporation Limited': `
    14:eb:b6 28:ee:52 30:68:93 34:60:f9 3c:52:a1 3c:64:cf 54:af:97 5c:e9:31 60:a4:b7 78:8c:b5 9c:53:22 9c:a2:f4
    a8:6e:84 b0:19:21 e4:fa:c4 ec:75:0c`,
  'NETGEAR': `
    00:09:5b 00:0f:b5 00:14:6c 00:18:4d 00:1b:2f 00:1e:2a 00:1f:33 00:22:3f 00:24:b2 00:26:f2 08:02:8e 08:36:c9
    10:0d:7f 10:da:43 20:0c:c8 20:4e:7f 28:80:88 28:c6:8e 2c:30:33 2c:b0:5d 30:46:9a 38:94:ed 3c:37:86 44:94:fc
    4c:60:de 50:6a:03 6c:b0:ce 74:44:01 78:d2:94 80:cc:9c 84:1b:5e 8c:3b:ad 94:18:65 94:a6:7e 9c:3d:cf 9c:c9:eb
    a0:04:60 a0:21:b7 a0:40:a0 a4:2b:8c b0:39:56 b0:7f:b9 b0:b9:8a bc:a5:11 c0:3f:0e c0:ff:d4 c4:04:15 c4:3d:c7
    cc:40:d0 dc:ef:09 e0:46:9a e0:91:f5 e4:f4:c6 e8:fc:af f8:73:94`,
  'ASUSTek COMPUTER INC.': `
    00:0c:6e 00:0e:a6 00:11:2f 00:11:d8 00:13:d4 00:15:f2 00:17:31 00:18:f3 00:1a:92 00:1b:fc 00:1d:60 00:1e:8c
    00:1f:c6 00:22:15 00:23:54 00:24:8c 00:26:18 04:42:1a 04:92:26 04:d4:c4 04:d9:f5 08:60:6e 08:62:66 0c:9d:92
    10:7b:44 10:bf:48 10:c3:7b 14:da:e9 14:dd:a9 18:31:bf 1c:87:2c 1c:b7:2c 20:cf:30 24:4b:fe 2c:4d:54 2c:56:dc
    2c:fd:a1 30:5a:3a 30:85:a9 34:97:f6 38:2c:4a 38:d5:47 3c:7c:3f 40:16:7e 40:b0:76 48:5b:39 4c:ed:fb 50:46:5d
    50:eb:f6 54:04:a6 54:a0:50 58:11:22 60:45:cb 60:a4:4c 70:4d:7b 70:8b:cd 74:d0:2b 78:24:af 7c:10:c9 88:d7:f6
    90:e6:ba 9c:5c:8e a0:36:bc a8:5e:45 ac:22:0b ac:9e:17 b0:6e:bf bc:ae:c5 bc:ee:7b c8:60:00 c8:7f:54 d0:17:c2
    d4:5d:64 d8:50:e6 e0:3f:49 e0:cb:4e f0:2f:74 f0:79:59 f4:6d:04 f8:32:e4 fc:34:97`,
  'Cisco-Linksys, LLC': `
    00:0c:41 00:0f:66 00:12:17 00:13:10 00:14:bf 00:16:b6 00:18:39 00:18:f8 00:1a:70 00:1c:10 00:1d:7e 00:1e:e5
    00:21:29 00:22:6b 00:23:69 00:25:9c 20:aa:4b 58:6d:8f 68:7f:74 c0:c1:c0`,
  'Belkin International Inc.': '08:86:3b 14:91:82 24:f5:a2 30:23:03 58:ef:68 94:10:3e b4:75:0e c0:56:27 e8:9f:80 ec:1a:59',
  'Aruba, a Hewlett Packard Enterprise Company': `
    00:0b:86 00:1a:1e 00:24:6c 04:bd:88 18:64:72 20:4c:03 20:a6:cd 24:de:c6 40:e3:d6 6c:f3:7f 70:3a:0e 84:d4:7e
    88:3a:30 94:b4:0f 9c:1c:12 ac:a3:1e b4:5d:50 d8:c7:c8 f0:5c:19`,
  'Cisco Meraki': '00:18:0a 0c:7b:c8 0c:8d:db 2c:3f:0b 34:56:fe 68:3a:1e 88:15:44 98:18:88 ac:17:c8 e0:55:3d e0:cb:bc f8:9e:28',
  'Cisco Systems, Inc': '00:00:0c 00:01:42 00:01:43 00:01:63 00:01:64 00:01:96 00:01:97 00:01:c7 00:01:c9',
  'ARRIS Group, Inc.': `
    00:00:ca 00:15:96 00:15:a2 00:15:a3 00:15:a4 00:1a:de 00:1d:ce 00:1d:d0 00:1d:d5 00:23:a2 00:23:ed 00:26:36
    14:d4:fe 1c:1b:68 20:3d:66 3c:36:e4 40:0d:10 44:e1:37 54:65:de 5c:57:1a 64:55:b1 6c:ca:08 74:56:12 84:61:a0
    84:e0:58 8c:09:f4 90:c7:92 94:87:7c 98:f7:81 a0:c5:62 ac:b3:13 b0:77:ac bc:64:4b c0:94:35 c8:63:fc d0:39:b3
    e0:b7:b1 e8:ed:05 f8:2d:c0 fc:51:a4`,
  'Technicolor CH USA Inc.': '18:62:2c 30:91:8f 58:23:8c 70:5a:9e 88:f7:c7 d4:35:1d e8:f1:b0 fc:52:8d',
  'Sagemcom Broadband SAS': '10:d7:b0 34:8a:ae 3c:81:d8 44:e9:dd 54:64:d9 68:15:90 7c:03:d8 88:a6:c6 94:fe:f4 a0:1b:29 a8:70:5d ac:3b:77 c0:ac:54 cc:33:bb d0:6e:de e8:be:81 f0:82:61',
  'AVM Audiovisuelles Marketing und Computersysteme GmbH': `
    00:04:0e 00:1c:4a 00:1f:3f 00:24:fe 08:96:d7 24:65:11 2c:3a:fd 2c:91:ab 34:31:c4 38:10:d5 3c:a6:2f 44:4e:6d
    5c:49:79 7c:ff:4d 98:9b:cb b0:f2:08 bc:05:43 c0:25:06 c8:0e:14 cc:ce:1e dc:39:6f e0:28:6d e8:df:70 f0:b0:14`,
  'Routerboard.com': '00:0c:42 08:55:31 18:fd:74 2c:c8:1b 48:8f:5a 4c:5e:0c 64:d1:54 6c:3b:6b 74:4d:28 78:9a:18 b8:69:f4 c4:ad:34 cc:2d:e0 d4:ca:6d dc:2c:6e e4:8d:8c',
  'Zyxel Communications Corporation': '00:13:49 00:19:cb 00:23:f8 00:a0:c5 10:7b:ef 40:4a:03 4c:9e:ff 58:8b:f3 5c:f4:ab 60:31:97 90:ef:68 a0:e4:cb b0:b2:dc bc:99:11 c8:6c:87 cc:5d:4e d8:ec:5e e4:18:6b ec:43:f6 fc:f5:28',
  'D-Link International': `
    00:05:5d 00:0d:88 00:0f:3d 00:11:95 00:13:46 00:15:e9 00:17:9a 00:19:5b 00:1b:11 00:1c:f0 00:1e:58 00:21:91
    00:22:b0 00:24:01 00:26:5a 00:50:ba 00:80:c8 14:d6:4d 1c:5f:2b 1c:7e:e5 1c:af:f7 1c:bd:b9 28:10:7b 28:3b:82
    34:08:04 3c:1e:04 40:9b:cd 54:b8:0a 5c:d9:98 78:54:2e 84:c9:b2 90:94:e4 9c:d6:43 a0:ab:1b b0:c5:54 b8:a3:86
    bc:f6:85 c0:a0:bb c4:a8:1d c8:be:19 c8:d3:a3 cc:b2:55 e4:6f:13 f0:7d:68 f4:8c:eb fc:75:16`,
  'Shenzhen Tenda Technology Co.,Ltd.': 'c8:3a:35 04:95:e6 b8:3a:08',
  'Fortinet, Inc.': '00:09:0f 08:5b:0e 70:4c:a5 90:6c:ac',
  'Ruckus Wireless': '58:b6:33 74:91:1a 8c:0c:90 c4:01:7c ec:58:ea',
  'Actiontec Electronics, Inc': '00:15:05 00:20:e0 00:26:62',
  'BUFFALO.INC': '00:07:40 00:0d:0b 00:16:01 00:1d:73 00:24:a5 10:6f:3f 18:c2:bf 4c:e6:76 84:af:ec b0:c7:45 cc:e1:d5 dc:fb:02',

  // ---------------------------------------------------------------- media / speakers / TVs / consoles
  'Sonos, Inc.': '00:0e:58 34:7e:5c 38:42:0b 48:a6:b8 54:2a:1b 5c:aa:fd 74:ca:60 78:28:ca 94:9f:3e b8:e9:37 c4:38:75 f0:f6:c1',
  'Roku, Inc.': '00:0d:4b 08:05:81 10:59:32 20:ef:bd 84:ea:ed ac:3a:7a b0:a7:37 b8:3e:59 b8:a1:75 c8:3a:6b cc:6d:a0 d0:4d:2c d8:31:34 dc:3a:5e',
  'Bose Corporation': '00:0c:8a 04:52:c7 08:df:1f 2c:41:a1 4c:87:5d 60:ab:d2',
  'D&M Holdings Inc.': '00:05:cd 00:06:78',
  'Yamaha Corporation': '00:a0:de ac:44:f2',
  'VIZIO, Inc': '00:19:9d',
  'Nintendo Co.,Ltd': `
    00:09:bf 00:16:56 00:17:ab 00:19:1d 00:19:fd 00:1a:e9 00:1b:7a 00:1b:ea 00:1c:be 00:1d:bc 00:1e:35 00:1e:a9
    00:1f:32 00:1f:c5 00:21:47 00:21:bd 00:22:4c 00:22:aa 00:22:d7 00:23:31 00:23:cc 00:24:1e 00:24:44 00:24:f3
    00:25:a0 00:26:59 00:27:09 04:03:d6 18:2a:7b 2c:10:c1 34:af:2c 40:d2:8a 40:f4:07 58:2f:40 58:bd:a3 5c:52:1e
    64:b5:c6 78:a2:a0 7c:bb:8a 8c:56:c5 8c:cd:e8 98:41:5c 98:b6:e9 98:e8:fa 9c:e6:35 a4:38:cc a4:5c:27 a4:c0:e1
    b8:78:26 b8:8a:ec b8:ae:6e cc:9e:00 cc:fb:65 d8:6b:f7 dc:68:eb e0:0c:7f e0:e7:51 e8:4e:ce ec:c4:0d`,
  'Sony Interactive Entertainment Inc.': '00:04:1f 00:13:15 00:15:c1 00:19:c5 00:1d:0d 00:1f:a7 00:24:8d 00:d9:d1 00:e4:21 0c:fe:45 28:0d:fc 2c:cc:44 5c:84:3c 70:9e:29 78:c8:81 a8:e3:ee bc:60:a7 c8:63:f1 f8:46:1c f8:d0:ac fc:0f:e6',

  // ---------------------------------------------------------------- printers
  'Seiko Epson Corporation': '00:00:48 00:26:ab 38:1a:52 44:d2:44 50:57:9c 64:c6:d2 64:eb:8c 9c:ae:d3 a4:ee:57 ac:18:26 b0:e8:92 dc:cd:2f e0:bb:9e f8:d0:27',
  'Brother Industries, LTD.': '00:1b:a9 00:80:77 30:05:5c 3c:2a:f4 b4:22:00',
  'Canon Inc.': '00:00:85 00:1e:8f 00:bb:c1 18:0c:ac 2c:9e:fc 60:12:8b 74:bf:c0 84:ba:3b 88:87:17 9c:32:ce f4:a9:97 f8:a2:6d',
  'Xerox Corporation': '00:00:aa 9c:93:4e',
  'Lexmark International, Inc.': '00:04:00 00:20:00 00:21:b7',
  'Ricoh Company, Ltd.': '00:00:74 00:26:73 58:38:79',
  'Zebra Technologies Inc': '00:07:4d ac:3f:a4',

  // ---------------------------------------------------------------- NAS
  'Synology Incorporated': '00:11:32 90:09:d0',
  'QNAP Systems, Inc.': '00:08:9b 24:5e:be',
  'ASUSTOR Inc.': '78:72:64',
  'Western Digital': '00:14:ee 00:90:a9',

  // ---------------------------------------------------------------- cameras
  'Hangzhou Hikvision Digital Technology Co.,Ltd.': `
    08:a1:89 10:12:fb 18:68:cb 24:0f:9b 24:28:fd 28:57:be 2c:a5:9c 40:ac:bf 44:19:b6 44:47:cc 4c:bd:8f 4c:f5:dc
    54:c4:15 58:03:fb 64:db:8b 68:6d:bc 80:7c:62 8c:e7:48 98:df:82 a4:14:37 ac:cb:51 bc:9b:5e bc:ad:28 c0:51:7e
    c0:56:e3 c4:2f:90 e8:a0:ed f8:4d:fc`,
  'Wyze Labs Inc': '2c:aa:8e d0:3f:27 7c:78:b2',
  'Ring LLC': '34:3e:a4 54:e0:19 9c:76:13',
  'Reolink Innovation Limited': 'ec:71:db',
  'Zhejiang Dahua Technology Co., Ltd.': 'e4:24:6c fc:b6:9d 6c:1c:71 c0:39:5a 40:7a:a4 e0:2e:fe 3c:ef:8c 90:02:a9 a0:bd:1d 14:a7:8b',
  'Axis Communications AB': '00:40:8c ac:cc:8e b8:a4:4f e8:27:25',

  // ---------------------------------------------------------------- smart home / IoT
  'Espressif Inc.': `
    08:3a:f2 0c:dc:7e 10:52:1c 18:fe:34 24:0a:c4 24:62:ab 24:6f:28 24:a1:60 2c:3a:e8 2c:f4:32 30:83:98 30:ae:a4
    34:86:5d 34:94:54 3c:61:05 3c:71:bf 40:91:51 40:f5:20 44:17:93 48:3f:da 48:55:19 4c:11:ae 50:02:91 58:bf:25
    5c:cf:7f 60:01:94 68:c6:3a 70:03:9f 78:21:84 7c:9e:bd 80:7d:3a 84:0d:8e 84:cc:a8 84:f3:eb 8c:aa:b5 94:b9:7e
    98:f4:ab a0:20:a6 a4:7b:9d a4:cf:12 ac:67:b2 b4:e6:2d bc:dd:c2 c4:4f:33 c4:5b:be c8:2b:96 c8:c9:a3 cc:50:e3
    d8:a0:1d d8:bf:c0 dc:4f:22 e0:98:06 e8:68:e7 e8:db:84 ec:94:cb ec:fa:bc f4:cf:a2`,
  'Tuya Smart Inc.': '10:5a:17 18:de:50 1c:90:ff 38:1f:8d 50:8a:06 68:57:2d 70:89:76 7c:f6:66 84:e3:42 a0:92:08 d8:1f:12 fc:67:1f',
  'Philips Lighting BV': '00:17:88 ec:b5:fa',
  'LIFI LABS MANAGEMENT PTY LTD': 'd0:73:d5',
  'ecobee inc': '44:61:32',
  'iRobot Corporation': '50:14:79',
  'SmartThings, Inc.': 'd0:52:a8 24:fd:5b 28:6d:97',
  'Netatmo': '70:ee:50',

  'Lumi United Technology Co., Ltd': '54:ef:44',
  'Texas Instruments': '00:12:4b',
  'Silicon Laboratories': '00:0b:57',
  'Withings': '00:24:e4',

  // ---------------------------------------------------------------- more media / printers / network / chips
  'HTC Corporation': '00:23:76 18:87:96 38:e7:d8 7c:61:93 90:e7:c4 d4:20:6d',
  'Oculus VR, LLC': '2c:26:17',
  'Pioneer Corporation': '00:e0:36',
  'Onkyo Corporation': '00:09:b0',
  'Slim Devices, Inc.': '00:04:20',
  'TiVo': '00:11:d9',
  'KYOCERA Corporation': '00:c0:ee',
  'KONICA MINOLTA HOLDINGS, INC.': '00:20:6b',
  'OKI Electric Industry Co., Ltd': '00:80:87',
  'Sercomm Corporation.': '00:c0:02',
  'GL Technologies (Hong Kong) Limited': '94:83:c4',
  'CradlePoint, Inc': '00:30:44',
  'DrayTek Corp.': '00:1d:aa 00:50:7f',
  'Juniper Networks': '00:05:85',
  'Super Micro Computer, Inc.': '00:25:90 00:30:48 0c:c4:7a 3c:ec:ef ac:1f:6b',
  'MediaTek Inc.': '00:0c:e7',
  'Ralink Technology, Corp.': '00:0c:43',
  'Atheros Communications, Inc.': '00:03:7f',
  'Broadcom': '00:10:18',
  'Marvell Semiconductor, Inc.': '00:50:43',

  // ---------------------------------------------------------------- VoIP phones
  'Polycom': '00:04:f2',
  'Yealink(Xiamen) Network Technology Co.,Ltd.': '00:15:65 80:5e:c0',
  'Grandstream Networks, Inc.': '00:0b:82',
};

/** 'a4:83:e7' -> 'Apple, Inc.' */
export const OUI_TABLE = Object.freeze(buildTable());

function buildTable() {
  const table = {};
  for (const [vendor, list] of Object.entries(VENDORS)) {
    for (const p of list.trim().split(/\s+/)) {
      if (!/^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/.test(p)) continue;
      // First assignment wins; duplicates are a data bug caught by the self-test in NETWORK_NOTES.md.
      if (!(p in table)) table[p] = vendor;
    }
  }
  return table;
}

/**
 * Vendor organisation name for a MAC, by its first 3 octets.
 * Randomized (locally administered), multicast and invalid MACs -> null.
 */
export function lookupVendor(mac) {
  const n = normalizeMac(mac);
  if (!n || isRandomizedMac(n) || isMulticastOrBroadcastMac(n)) return null;
  return OUI_TABLE[n.slice(0, 8)] ?? null;
}
