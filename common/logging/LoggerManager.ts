import { createLogger, format, transports, Logger } from 'winston';
require('dotenv').config();

class LoggerManager {
    private logger: Logger;

    constructor() {
        this.logger = createLogger({
            level: process.env.LOGGING_LEVEL,
            format: format.combine(
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format.printf(({ timestamp, level, message, ...meta }) => {
                    let formattedMessage = message

                    if (meta && Object.keys(meta).length > 0) {
                        formattedMessage += ' ' + JSON.stringify(meta, null, 2);
                    }

                    return `[${timestamp}] ${level.toUpperCase()}: ${formattedMessage}`;
                })
            ),
            transports: [
                new transports.Console({
                    format: format.combine(
                        this.uppercaseLevel(),
                        format.colorize({ all: true }),
                        format.printf(({ timestamp, level, message }) => {
                            return `[${timestamp}] ${level}: ${message}`;
                        })
                    )
                }),
                new transports.File({
                    filename: 'wallet_tracker.log',
                    format: format.combine(
                        format.json()
                    )
                })
            ],
        });
    }

    public uppercaseLevel = format((info) => {
        info.level = info.level.toUpperCase();
        return info;
    });

    public info(message: string): void {
        this.logger.info(message)
    }

    public error(message: string): void {
        this.logger.error(message);
    }

    public warn(message: string): void {
        this.logger.warn(message);
    }

    public debug(message: string): void {
        this.logger.debug(message);
    }

    public logObject(level: 'info' | 'warn' | 'error' | 'debug', title: string, object: any) {
        this.logger.log({
            level,
            message: `${title}:\n${JSON.stringify(object, null, 2)}`
        });
    }
}
export default new LoggerManager();

//Winston Logging Levels:
// error (massima gravità)
// warn
// info
// http
// verbose
// debug
// silly (minima gravità)
