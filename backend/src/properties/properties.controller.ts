import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuthedRequest } from '../common/auth-user';
import { CreateLocalDto, CreateSiteDto } from './properties.dto';
import { PropertiesService } from './properties.service';

@Controller('sites')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PROPRIETAIRE')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Post()
  createSite(@Req() req: AuthedRequest, @Body() dto: CreateSiteDto) {
    return this.properties.createSite(req.user.id, dto);
  }

  @Get()
  listSites(@Req() req: AuthedRequest) {
    return this.properties.listSites(req.user.id);
  }

  @Post(':siteId/locals')
  createLocal(@Req() req: AuthedRequest, @Param('siteId', ParseIntPipe) siteId: number, @Body() dto: CreateLocalDto) {
    return this.properties.createLocal(req.user.id, siteId, dto);
  }

  @Get(':siteId/locals')
  listLocals(@Req() req: AuthedRequest, @Param('siteId', ParseIntPipe) siteId: number) {
    return this.properties.listLocals(req.user.id, siteId);
  }
}
