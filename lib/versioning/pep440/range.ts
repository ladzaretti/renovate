import { gte, lt, lte, satisfies } from '@renovatebot/pep440';
import { parse as parseRange } from '@renovatebot/pep440/lib/specifier.js';
import { parse as parseVersion } from '@renovatebot/pep440/lib/version.js';
import { logger } from '../../logger';
import { regEx } from '../../util/regex';
import type { NewValueConfig } from '../types';

enum ReplaceUserPolicy {
  Major = 0,
  Minor,
  Micro,
  Bug,
}

/**
 *
 * @param ranges A {@link Range} array consists of user's allowed range
 * @returns A {@link ReplaceUserPolicy} set by the user
 * examlpe:
 * let >=19.12.2,<19.13.0 be user's range of exepted updates.
 * the corresponding return value will be "Minor".
 * let >=19.12.2,<20.12.9, "Major" will be returned.
 */
function getUserReplacePrecision(ranges: Range[]): ReplaceUserPolicy | null {
  if (ranges.length !== 2) {
    return null;
  }
  const lowerBound: number[] = parseVersion(ranges[0].version)?.release ?? [];
  const upperBound: number[] = parseVersion(ranges[1].version)?.release ?? [];
  const index = upperBound.findIndex((el, index) => el > lowerBound[index]);
  return ReplaceUserPolicy[ReplaceUserPolicy[index]];
}

/**
 *
 * @param newVersion A newly accepted update version
 * @param policy The user's range update precision
 * @returns A string represents a future version upper bound.
 *
 * example: newVersion set to be 20.3.2 and policy is "Minor".
 * 20.4.0 will be returned.
 * if policy == "Major", 21.0.0 will be returned.
 */
function getFutureReplaceVersion(
  newVersion: string,
  policy: ReplaceUserPolicy
): string {
  const toRelease: number[] = parseVersion(newVersion)?.release ?? [];
  const futureVersion = toRelease.map((num, index) => {
    // if (policy == toRelease.length - 1) {
    //   policy--;
    // }
    if (index < policy) {
      return num;
    }
    if (index == policy) {
      return num + 1;
    }
    return 0;
  });
  return futureVersion.join('.');
}

function getFutureVersion(
  baseVersion: string,
  newVersion: string,
  step: number
): string {
  const toRelease: number[] = parseVersion(newVersion)?.release ?? [];
  const baseRelease: number[] = parseVersion(baseVersion)?.release ?? [];
  let found = false;
  const futureRelease = baseRelease.map((basePart, index) => {
    if (found) {
      return 0;
    }
    const toPart = toRelease[index] || 0;
    if (toPart > basePart) {
      found = true;
      return toPart + step;
    }
    return toPart;
  });
  if (!found) {
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
  // no symbol: accept only that specific version specifed
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
  // newVersion is within range
  if (rangeStrategy === 'auto' || rangeStrategy === 'replace') {
    if (satisfies(newVersion, currentValue)) {
      return currentValue;
    }
  }
  // Unsupported rangeStartegy
  // Valid rangeStrategy values are: bump, extend, pin, replace.
  // https://docs.renovatebot.com/modules/versioning/#pep440-versioning
  if (!['replace', 'bump', 'widen'].includes(rangeStrategy)) {
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
          // lower the bound if the new version is lower than current range
          // this looks like a rollback
          return '>=' + newVersion;
        }
        // this is similar to ~=
        // For example, the following version clauses are equivalent:
        // ~= 2.2
        // >= 2.2, == 2.*
        // handle lower bound.
        if (
          ['replace', 'bump'].includes(rangeStrategy) &&
          range.operator === '>='
        ) {
          return range.operator + newVersion;
        }
        // otherwise treat it same as exclude
        return range.operator + range.version;
      }
      // this is used to exclude future versions
      if (range.operator === '<') {
        // if newVersion is that future version
        if (gte(newVersion, range.version)) {
          // newVersion is out of current range
          // get current user's range precision
          const userReplacePolicy = getUserReplacePrecision(ranges);
          if (rangeStrategy === 'replace' && userReplacePolicy != null) {
            //
            return (
              range.operator +
              getFutureReplaceVersion(newVersion, userReplacePolicy)
            );
          }
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
