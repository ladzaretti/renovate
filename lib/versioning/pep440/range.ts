import { gte, lt, lte, satisfies } from '@renovatebot/pep440';
import { parse as parseRange } from '@renovatebot/pep440/lib/specifier.js';
import { parse as parseVersion } from '@renovatebot/pep440/lib/version.js';
import { logger } from '../../logger';
import { regEx } from '../../util/regex';
import type { NewValueConfig } from '../types';

function getFutureVersion(
  baseVersion: string,
  newVersion: string,
  step: number
): string {
  const toRelease: number[] = parseVersion(newVersion)?.release ?? [];
  const baseRelease: number[] = parseVersion(baseVersion)?.release ?? [];
  let found = false;
  let set = -1;
  const futureRelease = baseRelease.map((basePart, index) => {
    const toPart = toRelease[index] || 0;
    if (found && set === -1) {
      set = index;
      return toPart;
    }
    if (found) {
      return 0;
    }
    if (toPart > basePart) {
      found = true;
    }
    return toPart;
  });
  if (set !== -1) {
    futureRelease[set === futureRelease.length - 1 ? set - 1 : set] += step;
  }
  if (!found) {
    futureRelease[futureRelease.length - 1] += step;
  }
  if (found && set === -1) {
    futureRelease[futureRelease.length - 1] += step;
  }
  return futureRelease.join('.');
}

interface Range {
  operator: string;
  prefix: string;
  version: string;
}

export function getNewValue({
  currentValue,
  rangeStrategy,
  currentVersion,
  newVersion,
}: NewValueConfig): string | null {
  // easy pin
  if (rangeStrategy === 'pin') {
    return '==' + newVersion;
  }
  if (currentValue === currentVersion) {
    return newVersion;
  }
  const ranges: Range[] = parseRange(currentValue);
  if (!ranges) {
    logger.warn({ currentValue }, 'Invalid pep440 currentValue');
    return null;
  }
  if (!ranges.length) {
    // an empty string is an allowed value for PEP440 range
    // it means get any version
    logger.warn('Empty currentValue: ' + currentValue);
    return currentValue;
  }
  if (rangeStrategy === 'auto' || rangeStrategy === 'replace') {
    if (satisfies(newVersion, currentValue)) {
      return currentValue;
    }
  }
  if (!['replace', 'bump'].includes(rangeStrategy)) {
    logger.debug(
      'Unsupported rangeStrategy: ' +
        rangeStrategy +
        '. Using "replace" instead.'
    );
    return getNewValue({
      currentValue,
      rangeStrategy: 'replace',
      currentVersion,
      newVersion,
    });
  }
  if (ranges.some((range) => range.operator === '===')) {
    // the operator "===" is used for legacy non PEP440 versions
    logger.warn(
      { currentValue },
      'PEP440 arbitrary equality (===) not supported'
    );
    return null;
  }
  let result = ranges
    .map((range) => {
      // used to exclude versions,
      // we assume that's for a good reason
      if (range.operator === '!=') {
        return range.operator + range.version;
      }

      // used to mark minimum supported version
      if (['>', '>='].includes(range.operator)) {
        if (lte(newVersion, range.version)) {
          // this looks like a rollback
          return '>=' + newVersion;
        }
        // this is similar to ~=
        if (rangeStrategy === 'bump' && range.operator === '>=') {
          return range.operator + newVersion;
        }
        // otherwise treat it same as exclude
        return range.operator + range.version;
      }

      // this is used to exclude future versions
      if (range.operator === '<') {
        // if newVersion is that future version
        if (gte(newVersion, range.version)) {
          // now here things get tricky
          // we calculate the new future version
          const futureVersion = getFutureVersion(range.version, newVersion, 1);
          return range.operator + futureVersion;
        }
        // otherwise treat it same as exclude
        return range.operator + range.version;
      }

      // keep the .* suffix
      if (range.prefix) {
        const futureVersion = getFutureVersion(range.version, newVersion, 0);
        return range.operator + futureVersion + '.*';
      }

      if (['==', '~=', '<='].includes(range.operator)) {
        return range.operator + newVersion;
      }

      // unless PEP440 changes, this won't happen
      // istanbul ignore next
      logger.error(
        { newVersion, currentValue, range },
        'pep440: failed to process range'
      );
      // istanbul ignore next
      return null;
    })
    .filter(Boolean)
    .join(', ');

  if (result.includes(', ') && !currentValue.includes(', ')) {
    result = result.replace(regEx(/, /g), ',');
  }

  if (!satisfies(newVersion, result)) {
    // we failed at creating the range
    logger.warn(
      { result, newVersion, currentValue },
      'pep440: failed to calculate newValue'
    );
    return null;
  }

  return result;
}

export function isLessThanRange(input: string, range: string): boolean {
  try {
    let invertResult = true;

    const results = range
      .split(',')
      .map((x) =>
        x
          .replace(regEx(/\s*/g), '')
          .split(regEx(/(~=|==|!=|<=|>=|<|>|===)/))
          .slice(1)
      )
      .map(([op, version]) => {
        if (['!=', '<=', '<'].includes(op)) {
          return true;
        }
        invertResult = false;
        if (['~=', '==', '>=', '==='].includes(op)) {
          return lt(input, version);
        }
        if (op === '>') {
          return lte(input, version);
        }
        // istanbul ignore next
        return false;
      });

    const result = results.every((res) => res === true);

    return invertResult ? !result : result;
  } catch (err) /* istanbul ignore next */ {
    return false;
  }
}
