/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

//types
import type {
  Profile,
  FuncTable,
  FrameTable,
  StackTable,
} from '../../../types/profile';

import type { UniqueStringArray } from '../../../../src/utils/unique-string-array';

//utils
import {
  getEmptyProfile,
  getEmptyThread,
} from '../../../profile-logic/data-structures';
import BinaryPlistParser, { UID } from './BinaryPlistParser';
import BinReader from './BinReader';

// TODO make helpers.js and move the appropriate helper functions into it
// TODO add the missing return types in the functions
// TODO I have used console.log() statements for debug purpose, I will remove them later
// TODO add Root frame at the top
// TODO fill remaining meta data inside profile

let fileReader;

function parseBinaryPlist(bytes) {
  const text = 'bplist00';
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== text.charCodeAt(i)) {
      throw new Error('File is not a binary plist');
    }
  }

  return new BinaryPlistParser(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  ).parseRoot();
}

function decodeUTF8(bytes: Uint8Array): string {
  const textDecoder = new TextDecoder();
  if (bytes[bytes.length - 1] === 0) {
    // Remove a single trailing null byte if present.
    return textDecoder.decode(bytes.subarray(0, -1));
  }
  return textDecoder.decode(bytes);
}

function followUID(objects: any[], value: any): any {
  return value instanceof UID ? objects[value.index] : value;
}

// This function constructs an object from given interpreter class and property list
function patternMatchObjectiveC(
  objects: any[],
  value: any,
  interpretClass: ($classname: string, obj: any) => any = x => x
): any {
  if (isDictionary(value) && value.$class) {
    const name = followUID(objects, value.$class).$classname;
    switch (name) {
      case 'NSDecimalNumberPlaceholder': {
        const length: number = value['NS.length'];
        const exponent: number = value['NS.exponent'];
        const byteOrder: number = value['NS.mantissa.bo'];
        const negative: boolean = value['NS.negative'];
        const mantissa = new Uint16Array(
          new Uint8Array(value['NS.mantissa']).buffer
        );
        let decimal = 0;

        for (let i = 0; i < length; i++) {
          let digit = mantissa[i];

          if (byteOrder !== 1) {
            digit = ((digit & 0xff00) >> 8) | ((digit & 0x00ff) << 8);
          }

          decimal += digit * Math.pow(65536, i);
        }

        decimal *= Math.pow(10, exponent);
        return negative ? -decimal : decimal;
      }

      // Replace NSData with a Uint8Array
      case 'NSData':
      case 'NSMutableData':
        return value['NS.bytes'] || value['NS.data'];

      // Replace NSString with a string
      case 'NSString':
      case 'NSMutableString':
        return value['NS.bytes'] ? decodeUTF8(value['NS.bytes']) : '';

      // Replace NSArray with an Array
      case 'NSArray':
      case 'NSMutableArray': {
        if ('NS.objects' in value) {
          return value['NS.objects'];
        }
        const array: any[] = [];
        while (true) {
          const object = 'NS.object.' + array.length;
          if (!(object in value)) {
            break;
          }
          array.push(value[object]);
        }
        return array;
      }
      case '_NSKeyedCoderOldStyleArray': {
        const count = value['NS.count'];

        // const size = value['NS.size']
        // Types are encoded as single printable characters.
        // See: https://github.com/apple/swift-corelibs-foundation/blob/76995e8d3d8c10f3f3ec344dace43426ab941d0e/Foundation/NSObjCRuntime.swift#L19
        // const type = String.fromCharCode(value['NS.type'])

        const array: any[] = [];
        for (let i = 0; i < count; i++) {
          const element = value['$' + i];
          array.push(element);
        }
        return array;
      }

      case 'NSDictionary':
      case 'NSMutableDictionary': {
        const map = new Map();
        if ('NS.keys' in value && 'NS.objects' in value) {
          for (let i = 0; i < value['NS.keys'].length; i++) {
            map.set(value['NS.keys'][i], value['NS.objects'][i]);
          }
        } else {
          while (true) {
            const key = 'NS.key.' + map.size;
            const object = 'NS.object.' + map.size;
            if (!(key in value) || !(object in value)) {
              break;
            }
            map.set(value[key], value[object]);
          }
        }
        return map;
      }
      default: {
        const converted = interpretClass(name, value);
        if (converted !== value) return converted;
      }
    }
  }
  return value;
}

function isDictionary(value: any): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === null
  );
}

function isArray(value: any): boolean {
  return value instanceof Array;
}

// This function populates data fields with given interpretClass(decided by various datatypes
// from readInstrumentsArchive function)
function expandKeyedArchive(
  root: any,
  interpretClass: ($classname: string, obj: any) => any = x => x
): any {
  // Sanity checks
  if (
    root.$version !== 100000 ||
    root.$archiver !== 'NSKeyedArchiver' ||
    !isDictionary(root.$top) ||
    !isArray(root.$objects)
  ) {
    throw new Error('Invalid keyed archive');
  }

  // Substitute NSNull
  if (root.$objects[0] === '$null') {
    root.$objects[0] = null;
  }

  // Pattern-match Objective-C constructs
  for (let i = 0; i < root.$objects.length; i++) {
    root.$objects[i] = patternMatchObjectiveC(
      root.$objects,
      root.$objects[i],
      interpretClass
    );
  }

  // Reconstruct the DAG from the parse tree
  const visit = (object: any) => {
    if (object instanceof UID) {
      return root.$objects[object.index];
    } else if (isArray(object)) {
      for (let i = 0; i < object.length; i++) {
        object[i] = visit(object[i]);
      }
    } else if (isDictionary(object)) {
      for (const key in object) {
        object[key] = visit(object[key]);
      }
    } else if (object instanceof Map) {
      const clone = new Map(object);
      object.clear();
      for (const [k, v] of clone.entries()) {
        object.set(visit(k), visit(v));
      }
    }
    return object;
  };
  for (let i = 0; i < root.$objects.length; i++) {
    visit(root.$objects[i]);
  }
  return visit(root.$top);
}

// This function creates an archived data for given buffer by interpreting various Instruments specific data types
function readInstrumentsArchive(buffer) {
  const byteArray = new Uint8Array(buffer);
  // console.log('byteArray', byteArray);
  const parsedPlist = parseBinaryPlist(byteArray);

  const data = expandKeyedArchive(parsedPlist, ($classname, object) => {
    switch ($classname) {
      case 'NSTextStorage':
      case 'NSParagraphStyle':
      case 'NSFont':
        // Stuff that's irrelevant for constructing a flamegraph
        return null;

      case 'PFTSymbolData': {
        const ret = Object.create(null);
        ret.symbolName = object.$0;
        ret.sourcePath = object.$1;
        ret.addressToLine = new Map<any, any>();
        for (let i = 3; ; i += 2) {
          const address = object['$' + i];
          const line = object['$' + (i + 1)];
          // eslint-disable-next-line eqeqeq
          if (address == null || line == null) {
            break;
          }
          ret.addressToLine.set(address, line);
        }
        return ret;
      }

      case 'PFTOwnerData': {
        const ret = Object.create(null);
        ret.ownerName = object.$0;
        ret.ownerPath = object.$1;
        return ret;
      }

      case 'PFTPersistentSymbols': {
        const ret = Object.create(null);
        const symbolCount = object.$4;

        ret.threadNames = object.$3;
        ret.symbols = [];
        for (let i = 1; i < symbolCount; i++) {
          ret.symbols.push(object['$' + (4 + i)]);
        }
        return ret;
      }

      case 'XRRunListData': {
        const ret = Object.create(null);
        ret.runNumbers = object.$0;
        ret.runData = object.$1;
        return ret;
      }

      case 'XRIntKeyedDictionary': {
        const ret = new Map();
        const size = object.$0;
        for (let i = 0; i < size; i++) {
          const key = object['$' + (1 + 2 * i)];
          const value = object['$' + (1 + (2 * i + 1))];
          ret.set(key, value);
        }
        return ret;
      }

      case 'XRCore': {
        const ret = Object.create(null);
        ret.number = object.$0;
        ret.name = object.$1;
        return ret;
      }
      default:
    }
    return object;
  });
  return data;
}

// This function adds a padding ahead of given string to make its length equal to a given width value
function zeroPad(s: string, width: number) {
  return new Array(Math.max(width - s.length, 0) + 1).join('0') + s;
}

function getOrThrow<K, V>(map: Map<K, V>, k: K): V {
  if (!map.has(k)) {
    throw new Error(`Expected key ${k}`);
  }
  return map.get(k);
}

function getOrInsert<K, V>(map: Map<K, V>, k: K, fallback: (k: K) => V): V {
  if (!map.has(k)) map.set(k, fallback(k));
  return map.get(k);
}

// This function extracts arrays of backtraceIDs which contains information about backtrace in recursive manner
async function getIntegerArrays(
  samples: Sample[],
  core: TraceDirectoryTree
): Promise<number[][]> {
  const uniquing = getOrThrow(core.subdirectories, 'uniquing');
  const arrayUniquer = getOrThrow(uniquing.subdirectories, 'arrayUniquer');
  const integeruniquerindex = getOrThrow(
    arrayUniquer.files,
    'integeruniquer.index'
  );
  const integeruniquerdata = getOrThrow(
    arrayUniquer.files,
    'integeruniquer.data'
  );

  // integeruniquer.index is a binary file containing an array of [byte offset, MB offset] pairs
  // that indicate where array data starts in the .data file

  // integeruniquer.data is a binary file containing an array of arrays of 64 bit integer.
  // The schema is a 32 byte header followed by a stream of arrays.
  // Each array consists of a 4 byte size N followed by N 8 byte little endian integers

  // This table contains the memory addresses of stack frames

  const indexreader = new BinReader(
    await fileReader(integeruniquerindex).asArrayBuffer()
  );
  const datareader = new BinReader(
    await fileReader(integeruniquerdata).asArrayBuffer()
  );

  // Header we don't care about
  indexreader.seek(32);

  const arrays: number[][] = [];

  while (indexreader.hasMore()) {
    const byteOffset =
      indexreader.readUint32() + indexreader.readUint32() * (1024 * 1024);

    if (byteOffset === 0) {
      // The first entry in the index table seems to just indicate the offset of
      // the header into the data file
      continue;
    }

    datareader.seek(byteOffset);

    let length = datareader.readUint32();
    const array: number[] = [];

    while (length--) {
      array.push(datareader.readUint64());
    }
    arrays.push(array);
  }

  return arrays;
}

// This function extracts samples from given core file
async function getRawSampleList(core: TraceDirectoryTree): Promise<Sample[]> {
  const stores = getOrThrow(core.subdirectories, 'stores');
  for (const storedir of stores.subdirectories.values()) {
    const schemaFile = storedir.files.get('schema.xml');
    if (!schemaFile) continue;
    const schema = await fileReader(schemaFile).asText(); // TODO: Getting an error while processing latest version profiles
    console.log('schema', schema);
    if (!/name="time-profile"/.exec(schema)) {
      continue;
    }
    const bulkstore = new BinReader(
      await fileReader(getOrThrow(storedir.files, 'bulkstore')).asArrayBuffer()
    );
    // Ignore the first 3 words
    bulkstore.readUint32();
    bulkstore.readUint32();
    bulkstore.readUint32();
    const headerSize = bulkstore.readUint32();
    const bytesPerEntry = bulkstore.readUint32();

    bulkstore.seek(headerSize);

    const samples: Sample[] = [];
    while (true) {
      // Schema as of Instruments 8.3.3 is a 6 byte timestamp, followed by a bunch
      // of stuff we don't care about, followed by a 4 byte backtrace ID
      const timestamp = bulkstore.readUint48();
      if (timestamp === 0) break;

      const threadID = bulkstore.readUint32();

      bulkstore.skip(bytesPerEntry - 6 - 4 - 4);
      const backtraceID = bulkstore.readUint32();
      samples.push({ timestamp, threadID, backtraceID });
    }
    return samples;
  }
  throw new Error('Could not find sample list');
}

// This function extracts core directory file which contains information about samples
// path: tree.subdirectories.corespace.subdirectories.run${runNumber}.core
function getCoreDirForRun(
  tree: TraceDirectoryTree,
  selectedRun: number
): TraceDirectoryTree {
  const corespace = getOrThrow(tree.subdirectories, 'corespace');
  const corespaceRunDir = getOrThrow(
    corespace.subdirectories,
    `run${selectedRun}`
  );
  return getOrThrow(corespaceRunDir.subdirectories, 'core');
}

// This function mainly extracts two entities: samples and arrays
// Here arrays contains all the information about stack trace at a given timestamp.
// Each samples has a field named 'backtraceID' which is an index into arrays
// Iterating recursively into arrays by given backtraceID it extracts a backtraceStack for each sample
export async function importRunFromInstrumentsTrace(
  args
): Promise<ProfileGroup> {
  const { tree, addressToFrameMap, runNumber } = args;
  const core = getCoreDirForRun(tree, runNumber);
  const samples = await getRawSampleList(core);
  const arrays = await getIntegerArrays(samples, core);

  console.log('samples', samples);
  console.log('addressToFrameMap', addressToFrameMap);
  const backtraceIDtoStack = new Map<number, FrameInfo[]>();

  function appendRecursive(k: number, stack: FrameInfo[]) {
    const frame = addressToFrameMap.get(k);
    if (frame) {
      stack.push(k);
    } else if (k in arrays) {
      for (const addr of arrays[k]) {
        appendRecursive(addr, stack);
      }
    } else {
      const rawAddressFrame: FrameInfo = {
        key: k,
        name: `0x${zeroPad(k.toString(16), 16)}`,
      };
      addressToFrameMap.set(k, rawAddressFrame);
      stack.push(k);
    }
  }

  for (const sample of samples) {
    getOrInsert(backtraceIDtoStack, sample.backtraceID, id => {
      const stack: FrameInfo[] = [];
      appendRecursive(id, stack);
      stack.reverse();
      return stack;
    });
  }

  for (const sample of samples) {
    sample.backtraceStack = backtraceIDtoStack.get(sample.backtraceID);
  }
  console.log('backtraceIDtoStack', backtraceIDtoStack);

  return {
    samples,
  };
}

// This function reads the 'form.template' file which contains all the important information about
// addressToFrameMap and Instruments' version
async function readFormTemplateFile(tree) {
  const formTemplate = tree.files.get('form.template'); // TODO check for empty formTemplate
  const archive = readInstrumentsArchive(
    await fileReader(formTemplate).asArrayBuffer()
  );

  // console.log('archive', archive);
  const version = archive['com.apple.xray.owner.template.version'];
  let selectedRunNumber = 1;
  if ('com.apple.xray.owner.template' in archive) {
    selectedRunNumber = archive['com.apple.xray.owner.template'].get(
      '_selectedRunNumber'
    );
  }
  let instrument = archive.$1;
  if ('stubInfoByUUID' in archive) {
    instrument = Array.from(archive.stubInfoByUUID.keys())[0];
  }
  const allRunData = archive['com.apple.xray.run.data'];

  const runs: FormTemplateRunData[] = [];
  for (const runNumber of allRunData.runNumbers) {
    const runData = getOrThrow<number, Map<any, any>>(
      allRunData.runData,
      runNumber
    );
    // console.log('runNumber', runNumber);
    // console.log('runData', runData);
    const symbolsByPid = getOrThrow<
      string,
      Map<number, { symbols: SymbolInfo[] }>
    >(runData, 'symbolsByPid');

    const addressToFrameMap = new Map<number, FrameInfo>();
    for (const symbols of symbolsByPid.values()) {
      for (const symbol of symbols.symbols) {
        if (!symbol) continue;
        const { sourcePath, symbolName, addressToLine } = symbol;
        for (const address of addressToLine.keys()) {
          getOrInsert(addressToFrameMap, address, () => {
            const name = symbolName || `0x${zeroPad(address.toString(16), 16)}`;
            const frame: FrameInfo = {
              key: `${sourcePath}:${name}`,
              name: name,
            };
            if (sourcePath) {
              frame.file = sourcePath;
            }
            return frame;
          });
        }
      }
      // console.log(counter);
      // console.log(addressToFrameMap);
      // console.log('runs', console.log(JSON.parse(JSON.stringify(runs))));
      runs.push({
        number: runNumber,
        addressToFrameMap,
      });
    }
  }

  return {
    version,
    instrument,
    selectedRunNumber,
    runs,
  };
}

// This function returns a directory tree where each node of tree
// is a object consist of name, files and subdirecotries fields
async function extractDirectoryTree(entry) {
  const node = {
    name: entry.name,
    files: new Map(),
    subdirectories: new Map(),
  };

  const children = await new Promise((resolve, reject) => {
    entry.createReader().readEntries((entries: any[]) => {
      resolve(entries);
    }, reject);
  });

  for (const child of children) {
    if (child.isDirectory) {
      const subtree = await extractDirectoryTree(child);
      node.subdirectories.set(subtree.name, subtree);
    } else {
      const file = await new Promise((resolve, reject) => {
        child.file(resolve, reject);
      });
      node.files.set(file.name, file);
    }
  }

  return node;
}

// This function checks weather the given profile is of Instruments type or not by checking the extension as a 'trace'
export function isInstrumentsProfile(file: mixed): boolean {
  let fileName = '';
  if (file && typeof file === 'object' && typeof file.name === 'string') {
    fileName = file.name;
  }

  const fileMetaData = fileName.split('.');
  if (
    fileMetaData.length === 1 ||
    (fileMetaData[0] === '' && fileMetaData.length === 2)
  ) {
    return false;
  }
  return fileMetaData.pop() === 'trace';
}

// This function return an index of function from funcTable if it already exists otherwise
// it creates a new entry into funcTable and returns that index
function getOrCreateFunc(
  funcTable: FuncTable,
  funcKeyToIndex: Map<string, number>,
  stringTable: UniqueStringArray,
  name: string,
  fileName: string,
  funcKey: string
) {
  let indexToFunc = -1;

  if (funcKeyToIndex.has(funcKey)) {
    indexToFunc = funcKeyToIndex.get(funcKey);
  } else {
    funcKeyToIndex.set(funcKey, funcTable.length);
    funcTable.name.push(stringTable.indexForString(name));
    funcTable.fileName.push(stringTable.indexForString(fileName));
    funcTable.isJS.push(false);
    funcTable.resource.push(-1);
    funcTable.lineNumber.push(null);
    funcTable.columnNumber.push(null);
    indexToFunc = funcTable.length;
    funcTable.length++;
  }

  return indexToFunc;
}

// This function creates a new frame inside frameTable and returns index of that newly created frame
function createFrame(
  frameTable: FrameTable,
  stringTable: UniqueStringArray,
  frameKeyToIndex: Map<string, number>,
  indexToFunc: number,
  frameAddress: string
) {
  frameTable.func.push(indexToFunc);
  frameTable.category.push(1); // TODO: Make the function to get the index of 'Other' category
  frameTable.address.push(stringTable.indexForString(`${frameAddress}`));
  frameTable.implementation.push(null);
  frameTable.line.push(null);
  frameTable.column.push(null);
  frameKeyToIndex.set(frameAddress, frameTable.length);
  frameTable.length++;
}

// This function creates a new stack inside stackTable and returns index of that newly created stack
function createStack(
  stackTable: StackTable,
  stringTable: UniqueStringArray,
  stackKeyToIndex: Map<string, number>,
  stackKey: string,
  parentIndex: number | null,
  frame: number
) {
  stackTable.prefix.push(parentIndex);
  stackTable.frame.push(frame);
  stackKeyToIndex.set(stackKey, stackTable.length);
  stackTable.category.push(1);
  stackTable.length++;
}

// This function returns a processed thread with all the tables filled( funcTable, frameTable, stackTable, stringTable and samples)
// addressToFrame map here is a map between frameAddress and details for that frame.
// Each sample is a tuple made up of (timestamp, threadID, backtraceID, backtraceStack)
function getProcessedThread(threadId, samples, addressToFrameMap) {
  const thread = getEmptyThread();
  const {
    funcTable,
    frameTable,
    stackTable,
    stringTable,
    samples: samplesTable,
  } = thread;

  thread.name = `Thread ${threadId}`;

  const funcKeyToIndex = new Map<string, number>();
  const frameKeyToIndex = new Map<string, number>();
  const stackKeyToIndex = new Map<string, number>();

  // We don't have (root) function in our data.
  // So, we have to explicitly add it in the funcTable, frameTable and then stackTable
  // We have defined the address of (root) frame as $00000000.
  // $ sign here is intentionally, because we might get a frame whose address is '00000000'

  const rootFuncName = '(root)';
  const rootFrameAddress = '$00000000';
  const rootFuncFileName = '';
  const rootFuncKey = '(root)';

  const indexOfRootFunc = getOrCreateFunc(
    funcTable,
    funcKeyToIndex,
    stringTable,
    rootFuncName,
    rootFuncFileName,
    rootFuncKey
  );

  createFrame(
    frameTable,
    stringTable,
    frameKeyToIndex,
    indexOfRootFunc,
    rootFrameAddress
  );

  const rootStackKey = 'rootStack';

  createStack(
    stackTable,
    stringTable,
    stackKeyToIndex,
    rootStackKey,
    null,
    frameKeyToIndex.get(rootFrameAddress)
  );

  for (const frameData of addressToFrameMap) {
    const frameMetaData = frameData[1];
    const frameAddress = frameData[0];

    const indexToFunc = getOrCreateFunc(
      funcTable,
      funcKeyToIndex,
      stringTable,
      frameMetaData.name,
      frameMetaData.file || '',
      frameMetaData.key
    );

    createFrame(
      frameTable,
      stringTable,
      frameKeyToIndex,
      indexToFunc,
      frameAddress
    );
  }

  for (const sample of samples) {
    const stackTrace = sample.backtraceStack;
    let parentIndex = stackKeyToIndex.get(rootStackKey);

    for (let index = 0; index < stackTrace.length; index++) {
      const frameAddress = stackTrace[index];
      const keyOfStackKeyToIndexMap = '$' + parentIndex + '$' + frameAddress;

      if (!stackKeyToIndex.has(keyOfStackKeyToIndexMap)) {
        createStack(
          stackTable,
          stringTable,
          stackKeyToIndex,
          keyOfStackKeyToIndexMap,
          parentIndex,
          frameKeyToIndex.get(frameAddress)
        );
      }

      parentIndex = stackKeyToIndex.get(keyOfStackKeyToIndexMap);

      if (index === stackTrace.length - 1) {
        samplesTable.stack.push(stackKeyToIndex.get(keyOfStackKeyToIndexMap));
        samplesTable.time.push(sample.timestamp / 1000000); // TODO: Doubt
        samplesTable.responsiveness.push(null);
        samplesTable.length++;
      }
    }
  }

  return thread;
}

// This function creates a thread for each group of samples(by threadID)
function pushThreadsInProfile(profile, addressToFrameMap, samples) {
  const threadIDToSamples = new Map();
  for (const sample of samples) {
    if (threadIDToSamples.has(sample.threadID)) {
      threadIDToSamples.get(sample.threadID).push(sample);
    } else {
      threadIDToSamples.set(sample.threadID, [sample]);
    }
  }

  for (const threadID of threadIDToSamples.keys()) {
    const processedThread = getProcessedThread(
      threadID,
      threadIDToSamples.get(threadID),
      addressToFrameMap
    );
    profile.threads.push(processedThread);
  }
}

export async function convertInstrumentsProfile(
  entry: mixed,
  fileReaderHelper: fileReader
): Profile {
  fileReader = fileReaderHelper;
  const tree = await extractDirectoryTree(entry);
  // console.log('tree', tree);

  const {
    version,
    runs,
    instrument,
    selectedRunNumber,
  } = await readFormTemplateFile(tree);

  console.log('version', version);
  console.log('runs', runs);
  // console.log('instrument', instrument); TODO: Use version and instruments' information into meta data if possible
  console.log('selectedRunNumber', selectedRunNumber);

  if (instrument !== 'com.apple.xray.instrument-type.coresampler2') {
    throw new Error(
      `The only supported instrument from .trace import is "com.apple.xray.instrument-type.coresampler2". Got ${instrument}`
    );
  }

  const profile = getEmptyProfile();

  const { addressToFrameMap, number } = runs[0];
  // For now, we will just process the first run

  const group = await importRunFromInstrumentsTrace({
    tree,
    addressToFrameMap,
    runNumber: number,
  });
  console.log('group', group);

  // for (let i = 0; i < 10; i++) {
  //   group.samples[i].threadID = 1;
  // }
  // To check how our functionality will behave for multi threaded samples

  pushThreadsInProfile(profile, addressToFrameMap, group.samples);

  profile.meta.platform = 'Macintosh';
  console.log('profile', profile);
  return profile;
}