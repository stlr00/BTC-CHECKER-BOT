import { Module } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module.js';
import { MempoolModule } from '../mempool/mempool.module.js';
import { PricesModule } from '../prices/prices.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { WatcherModule } from '../watcher/watcher.module.js';
import { BotCore } from './bot.core.js';
import { MessagesService } from './messages.service.js';
import { RefsService } from './refs.service.js';

@Module({
  imports: [GeoModule, MempoolModule, PricesModule, StorageModule, TransportModule, WatcherModule],
  providers: [BotCore, MessagesService, RefsService],
})
export class BotModule {}
